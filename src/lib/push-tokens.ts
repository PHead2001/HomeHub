/** Matches the Firestore rule for users/{email}/private/push. */
export const MAX_PUSH_TOKENS = 20;

const tokenList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((token): token is string => typeof token === 'string' && token.length > 0) : [];

/**
 * The token list to store after this device subscribes. Stored tokens are kept
 * in the order they were added (oldest first); legacy profile tokens follow,
 * then this device's token goes last. Duplicates are removed (a re-subscribing
 * device moves to the end), and when the list would exceed the rules' cap the
 * oldest tokens are dropped, so subscribing never fails on the cap.
 */
export function nextPushTokens(
  storedTokens: unknown,
  legacyTokens: unknown,
  deviceToken: string,
  max: number = MAX_PUSH_TOKENS,
): string[] {
  const others = [...new Set([...tokenList(storedTokens), ...tokenList(legacyTokens)])]
    .filter(token => token !== deviceToken);
  const tokens = deviceToken ? [...others, deviceToken] : others;
  return tokens.slice(Math.max(0, tokens.length - Math.max(1, max)));
}
