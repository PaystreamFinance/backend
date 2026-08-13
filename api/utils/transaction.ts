import {
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
  Connection,
} from '@solana/web3.js'

/**
 * Serialize a transaction (Transaction or VersionedTransaction) to base64 string for Privy
 *
 * @param tx - Transaction or VersionedTransaction to serialize
 * @returns Base64 encoded transaction string
 */
export function serializeTransactionForPrivy(
  tx: Transaction | VersionedTransaction,
): string {
  if (tx instanceof VersionedTransaction) {
    return Buffer.from(tx.serialize()).toString('base64')
  } else {
    return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString(
      'base64',
    )
  }
}

/**
 * Convert a VersionedTransaction to a Transaction
 * Decompiles the versioned transaction message and reconstructs as a Transaction
 *
 * @param versionedTx - VersionedTransaction to convert
 * @param connection - Solana connection to fetch address lookup tables
 * @returns Transaction object
 */
export async function convertVersionedToTransaction(
  versionedTx: VersionedTransaction,
  connection: Connection,
): Promise<Transaction> {
  const message = versionedTx.message
  const altAccountResponses = await Promise.all(
    message.addressTableLookups.map((l) =>
      connection.getAddressLookupTable(l.accountKey),
    ),
  )

  const altAccounts: AddressLookupTableAccount[] = altAccountResponses.map(
    (item) => {
      if (item.value == null) throw new Error('ALT is null')
      return item.value
    },
  )

  const decompiledMessage = TransactionMessage.decompile(message, {
    addressLookupTableAccounts: altAccounts,
  })

  const tx = new Transaction()
  for (const ix of decompiledMessage.instructions) {
    tx.add(ix)
  }

  return tx
}
