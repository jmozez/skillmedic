/** Line number (1-based) of an offset in a text. */
export const lineOf = (text: string, offset: number) => {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** Rough token estimate at about 4 characters per token. Real tokenisers differ by model. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Invisible, control, bidi and Unicode tag characters (tag characters spell hidden ASCII). Tabs and newlines are fine. */
export const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|\udb40[\udc00-\udc7f]/g;

export const describeChar = (c: string) =>
  c.length === 2 ? "a Unicode tag character" : `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
