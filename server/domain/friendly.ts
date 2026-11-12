/**
 * What people see when something goes wrong. Short, calm, plain words. No status codes, no PayPal state names,
 * no tool names, no raw provider text. The technical detail goes to the audit log and to the server console only.
 */
export const FRIENDLY = {
  paypalFailed: "PayPal could not do that right now. Nothing was changed. Try again in a minute.",
  paypalUnreachable: "PayPal could not be reached right now. Nothing was changed. Try again in a minute.",
  paypalUnknown: "PayPal did not answer in time, so this may have gone through. Check the dispute in PayPal. Make Good will not send it again by itself.",
  refundFailed: "PayPal could not complete the refund right now. Nothing was paid out. Try again in a minute.",
  refundNotDone: "PayPal has not completed that refund. Nothing was paid out. Check it in PayPal before trying again.",
  aiFailed: "The AI could not answer right now. Nothing was changed. Try again in a minute.",
  importFailed: "That dispute could not be found. Check the id and try again in a minute.",
  generic: "Something went wrong on our side. Nothing was changed. Try again in a minute.",
} as const;

/** Log the real error for whoever runs the server, never for the person using the app. */
export function logTechnical(where: string, e: unknown): void {
  const text = e instanceof Error ? e.message : String(e);
  console.error(`[make-good] ${where}: ${text.slice(0, 400)}`);
}

/** Words that mean "this came straight from a provider or from the app's own internals". Shared with the web app and the tests. */
export const TECHNICAL_PATTERNS: RegExp[] = [
  /\b[A-Z][A-Z]+_[A-Z_]{3,}\b/, // PayPal style codes: REQUIRED_OTHER_PARTY_ACTION
  /\b(?:get|list|create|send|provide|accept)_(?:dispute|disputes|refund|claim|message|evidence)[a-z_]*\b/i, // tool names
  /\bprovide_evidence\b|\bsend_message\b|\baccept_claim\b/,
  /\bstage [A-Za-z]+,? state\b/i,
  /\bHTTP\b|\bstatus (?:code )?[45]\d\d\b|\(\s*[2345]\d\d\s*\)/,
  /\bAI API error\b|\btool failed\b|\bECONN\w*|\bETIMEDOUT\b|\bfetch failed\b|\bUnexpected token\b|\bundefined\b|\bis not valid JSON\b/i,
  /\bat \S+:\d+:\d+/, // stack frames
];

export function looksTechnical(text: string): boolean {
  return TECHNICAL_PATTERNS.some((re) => re.test(text));
}

/** Text a person will read: the original if it is plain, otherwise the calm fallback. */
export function plainOr(text: string, fallback: string = FRIENDLY.paypalFailed): string {
  return looksTechnical(text) ? fallback : text;
}
