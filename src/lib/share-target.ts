import { normalizeSourceUrl } from '@/lib/shopping-items';

export type SharedContent = {
  /** Suggested item name; the member can edit it before saving. */
  itemName: string;
  /** http(s) link found in the shared URL or text, if any. */
  url?: string;
  /** Raw shared title/text, trimmed, for the preview. */
  title?: string;
  text?: string;
};

const MAX_FIELD_LENGTH = 2000;
export const MAX_ITEM_NAME_LENGTH = 120;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

const clean = (value: string | undefined) => {
  const trimmed = value?.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LENGTH);
  return trimmed ? trimmed : undefined;
};

const truncate = (value: string) =>
  value.length > MAX_ITEM_NAME_LENGTH ? `${value.slice(0, MAX_ITEM_NAME_LENGTH - 1).trimEnd()}…` : value;

/**
 * Normalizes Web Share Target parameters. Apps disagree on where they put the
 * link (Android often sends it inside `text`), so the first http(s) URL from
 * `url` or `text` is used, and the item name comes from the title, then the
 * text without the link, then the link's host name.
 */
export function parseSharedContent(input: { title?: string; text?: string; url?: string }): SharedContent {
  const title = clean(input.title);
  const text = clean(input.text);
  const url = normalizeSourceUrl(clean(input.url)) ?? normalizeSourceUrl(text?.match(URL_PATTERN)?.[0]);

  const textWithoutUrl = clean(text?.replace(URL_PATTERN, ' '));
  let hostName: string | undefined;
  if (url) {
    try {
      hostName = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      hostName = undefined;
    }
  }

  return {
    itemName: truncate(title ?? textWithoutUrl ?? hostName ?? ''),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
  };
}
