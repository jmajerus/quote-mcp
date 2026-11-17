/**
 * Keys in links people read, written readably: a work key, citekey, concept slug, or book id keeps ":" and "@"
 * as themselves (?work=zotero:users/1/ABCD1234, /admin/concepts/human-work:mobbing), as holdings-mcp writes them.
 * Both are legal in a path segment of a path starting with "/" and in a query; "/" and "," are legal in a query
 * too. Links with these encoded keep working: the routes decode either form. Requests to other services keep
 * full encoding.
 */
const readable = (encoded: string) => encoded.replace(/%(3A|40)/gi, (m) => decodeURIComponent(m));

/** One path segment, with ":" and "@" left as they are. */
export const pathSegment = (value: string) => readable(encodeURIComponent(value));

/** One query value, with ":", "@", "/", and "," left as they are, and a space as "+". */
export const queryValue = (value: string) => readable(encodeURIComponent(value)).replace(/%20/g, "+").replace(/%(2F|2C)/gi, (m) => decodeURIComponent(m));

/** A query string from the parameters that have a value ("" for none), written readably; `skip` drops more values. */
export function queryString(params: Record<string, unknown>, skip: (v: unknown) => boolean = () => false): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && !skip(v))
    .map(([k, v]) => `${queryValue(k)}=${queryValue(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}
