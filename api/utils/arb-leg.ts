/**
 * Resolve which ticker to use on a given protocol when closing a pair.
 *
 * If the caller knows both legs' (protocol, symbol) — typically from a DB
 * lookup or a worker-supplied job payload — this picks the right ticker for
 * each leg. Otherwise it falls back to the shared `fallback` ticker (used by
 * legacy single-ticker pairs and pre-PAY-804 manual closes).
 */
export function resolveLegMarket(
  protocol: string,
  legs: {
    longProtocol?: string | null
    longSymbol?: string | null
    shortProtocol?: string | null
    shortSymbol?: string | null
    fallback: string
  },
): string {
  if (legs.longProtocol && legs.longSymbol && protocol === legs.longProtocol) return legs.longSymbol
  if (legs.shortProtocol && legs.shortSymbol && protocol === legs.shortProtocol) return legs.shortSymbol
  return legs.fallback
}
