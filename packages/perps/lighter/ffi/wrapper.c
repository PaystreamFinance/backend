#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

// Struct definitions matching the .h file
typedef struct {
    char* privateKey;
    char* publicKey;
    char* err;
} ApiKeyResponse;

typedef struct {
    uint8_t txType;
    char* txInfo;
    char* txHash;
    char* messageToSign;
    char* err;
} SignedTxResponse;

typedef struct {
    char* str;
    char* err;
} StrOrErr;

// Function pointer types matching the v1.0.4 Go/CGO signatures (lighter-signer-linux-amd64.h)
typedef ApiKeyResponse (*GenerateAPIKeyFn)(void);
typedef char* (*CreateClientFn)(char*, char*, int, int, long long);
typedef char* (*CheckClientFn)(int, long long);
typedef SignedTxResponse (*SignChangePubKeyFn)(char*, long long, int, long long);
// v1.0.4 SignCreateOrder has 16 params (3 integrator params added after orderExpiry)
typedef SignedTxResponse (*SignCreateOrderFn)(int, long long, long long, int, int, int, int, int, int, long long, long long, int, int, long long, int, long long);
typedef SignedTxResponse (*SignCancelOrderFn)(int, long long, long long, int, long long);
typedef StrOrErr (*CreateAuthTokenFn)(long long, int, long long);

static void* handle = NULL;

// Platform-specific signer library filename
#if defined(__APPLE__) && defined(__aarch64__)
  #define SIGNER_LIB "lighter-signer-darwin-arm64.dylib"
#elif defined(__linux__) && defined(__x86_64__)
  #define SIGNER_LIB "lighter-signer-linux-amd64.so"
#elif defined(__linux__) && defined(__aarch64__)
  #define SIGNER_LIB "lighter-signer-linux-arm64.so"
#else
  #error "Unsupported platform for lighter-signer"
#endif

__attribute__((constructor))
static void load_signer(void) {
    Dl_info info;
    dladdr((void*)load_signer, &info);
    char path[4096];
    strncpy(path, info.dli_fname, sizeof(path) - 1);
    char* last_slash = strrchr(path, '/');
    if (last_slash) {
        strcpy(last_slash + 1, SIGNER_LIB);
    } else {
        strcpy(path, "./" SIGNER_LIB);
    }
    handle = dlopen(path, RTLD_NOW);
    if (!handle) {
        fprintf(stderr, "wrapper: failed to load signer: %s\n", dlerror());
    }
}

// All wrapper functions use long long for integer params to avoid
// bun:ffi i32/i64 stack alignment issues. The internal calls cast
// back to the correct types for the Go/CGO functions.

void WrapGenerateAPIKey(ApiKeyResponse* out) {
    GenerateAPIKeyFn fn = (GenerateAPIKeyFn)dlsym(handle, "GenerateAPIKey");
    *out = fn();
}

char* WrapCreateClient(char* url, char* privateKey, long long chainId, long long apiKeyIndex, long long accountIndex) {
    CreateClientFn fn = (CreateClientFn)dlsym(handle, "CreateClient");
    return fn(url, privateKey, (int)chainId, (int)apiKeyIndex, accountIndex);
}

char* WrapCheckClient(long long apiKeyIndex, long long accountIndex) {
    CheckClientFn fn = (CheckClientFn)dlsym(handle, "CheckClient");
    return fn((int)apiKeyIndex, accountIndex);
}

void WrapSignChangePubKey(SignedTxResponse* out, char* pubKey, long long nonce, long long apiKeyIndex, long long accountIndex) {
    SignChangePubKeyFn fn = (SignChangePubKeyFn)dlsym(handle, "SignChangePubKey");
    *out = fn(pubKey, nonce, (int)apiKeyIndex, accountIndex);
}

// v1.0.4 SignCreateOrder has 16 params (3 integrator params were added).
// We split into two Bun→C calls (≤7 args each) to stay under Bun FFI limits.
// The C→Go call passes all 16 params correctly. Static storage is safe
// (single-threaded worker).

static long long sco_params[10];

void WrapSetCreateOrderParams(
    long long marketIndex, long long clientOrderIndex, long long baseAmount,
    long long price, long long isAsk, long long orderType, long long timeInForce
) {
    sco_params[0] = marketIndex;
    sco_params[1] = clientOrderIndex;
    sco_params[2] = baseAmount;
    sco_params[3] = price;
    sco_params[4] = isAsk;
    sco_params[5] = orderType;
    sco_params[6] = timeInForce;
}

void WrapExecCreateOrder(
    SignedTxResponse* out,
    long long reduceOnly, long long triggerPrice, long long orderExpiry,
    long long nonce, long long apiKeyIndex, long long accountIndex
) {
    static SignCreateOrderFn fn = NULL;
    if (!fn) fn = (SignCreateOrderFn)dlsym(handle, "SignCreateOrder");
    *out = fn(
        (int)sco_params[0], sco_params[1], sco_params[2], (int)sco_params[3],
        (int)sco_params[4], (int)sco_params[5], (int)sco_params[6],
        (int)reduceOnly, (int)triggerPrice, orderExpiry,
        0LL, 0, 0,  /* integratorAccountIndex, integratorTakerFee, integratorMakerFee */
        nonce, (int)apiKeyIndex, accountIndex
    );
}

void WrapSignCancelOrder(SignedTxResponse* out, long long marketIndex, long long orderIndex, long long nonce, long long apiKeyIndex, long long accountIndex) {
    SignCancelOrderFn fn = (SignCancelOrderFn)dlsym(handle, "SignCancelOrder");
    *out = fn((int)marketIndex, orderIndex, nonce, (int)apiKeyIndex, accountIndex);
}

typedef SignedTxResponse (*SignUpdateLeverageFn)(int, int, int, long long, int, long long);

void WrapSignUpdateLeverage(SignedTxResponse* out, long long marketIndex, long long initialMarginFraction, long long marginMode, long long nonce, long long apiKeyIndex, long long accountIndex) {
    SignUpdateLeverageFn fn = (SignUpdateLeverageFn)dlsym(handle, "SignUpdateLeverage");
    *out = fn((int)marketIndex, (int)initialMarginFraction, (int)marginMode, nonce, (int)apiKeyIndex, accountIndex);
}

void WrapCreateAuthToken(StrOrErr* out, long long deadline, long long apiKeyIndex, long long accountIndex) {
    CreateAuthTokenFn fn = (CreateAuthTokenFn)dlsym(handle, "CreateAuthToken");
    *out = fn(deadline, (int)apiKeyIndex, accountIndex);
}

typedef SignedTxResponse (*SignWithdrawFn)(int, int, unsigned long long, long long, int, long long);

void WrapSignWithdraw(SignedTxResponse* out, long long assetIndex, long long routeType, long long amount, long long nonce, long long apiKeyIndex, long long accountIndex) {
    SignWithdrawFn fn = (SignWithdrawFn)dlsym(handle, "SignWithdraw");
    *out = fn((int)assetIndex, (int)routeType, (unsigned long long)amount, nonce, (int)apiKeyIndex, accountIndex);
}

// SignTransfer has 10 params — split into two Bun→C calls (≤7 args each).
// Static storage is safe (single-threaded worker).
typedef SignedTxResponse (*SignTransferFn)(long long, int16_t, uint8_t, uint8_t, long long, long long, char*, long long, int, long long);

static long long st_params[4];
static char* st_memo = NULL;

void WrapSetTransferParams(long long toAccountIndex, long long assetIndex, long long fromRouteType, long long toRouteType, long long amount, long long usdcFee) {
    st_params[0] = toAccountIndex;
    st_params[1] = assetIndex;
    st_params[2] = fromRouteType;
    st_params[3] = toRouteType;
    // amount and fee stored in extra slots
    // reuse sco_params for overflow
    sco_params[0] = amount;
    sco_params[1] = usdcFee;
}

void WrapExecTransfer(SignedTxResponse* out, char* memo, long long nonce, long long apiKeyIndex, long long accountIndex) {
    static SignTransferFn fn = NULL;
    if (!fn) fn = (SignTransferFn)dlsym(handle, "SignTransfer");
    *out = fn(
        st_params[0], (int16_t)st_params[1], (uint8_t)st_params[2], (uint8_t)st_params[3],
        sco_params[0], sco_params[1],
        memo, nonce, (int)apiKeyIndex, accountIndex
    );
}
