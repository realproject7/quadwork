// #1209: a project id travels in a dashboard URL as one percent-encoded
// component (/project/<id>, /settings#project-<id>), and the browser hands it
// back still encoded: usePathname() returns the URL's pathname as it is, and
// location.hash its fragment. This undoes that one encoding.
export function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Not a valid escape, such as a hand-typed /project/100%: the browser keeps
    // a lone "%" as typed, so the text already is the id.
    return value;
  }
}
