# Launch checklist: privacy and legal

Not legal advice. These are the areas of law that most often cause trouble for a new web product, matched to what Aletheon actually does **today** and what must be done **before** each feature ships. Have a lawyer review the terms and privacy notice before the hosted service opens.

A note on the scary numbers that circulate about this topic: they are usually the statutory **maximum per violation**, not what a typical case costs, and enforcement varies a lot by country and state. The areas of law are real, though, and the fixes are cheap compared with the risk. Check current amounts and rules at the time you launch.

## Status today (the static website)

| Risk | Applies today? | Evidence |
| --- | --- | --- |
| Sign-up without an age check (children's privacy, e.g. COPPA in the US, age of digital consent in the EU) | No: the site has no sign-up | No forms or accounts in `site/` |
| Fonts loaded from Google servers (a Munich court awarded damages over this in 2022) | No | Pages use installed system fonts; no request to any font host |
| Analytics with session replay or keystroke capture (California wiretapping suits) | No | No analytics, tracking or third-party scripts at all |
| Marketing email without unsubscribe or postal address (CAN-SPAM, GDPR) | No: the project sends no email | Nothing sends email |
| Subscription terms hidden near the buy button (US state auto-renewal laws, FTC rules) | No: payments are not built | Schema has nullable Stripe columns only |
| User-uploaded content without a registered DMCA agent | No: nothing users upload is shown publicly | Evidence is private to a project or team |
| Cookies and consent banners | No cookies are set | `site/privacy.html` says so, and it must stay true |

`site/privacy.html` describes exactly this state. If any row above stops being true, change that page first.

## Before Aletheon Cloud opens (accounts, teams, billing)

1. **Age.** Decide the minimum age (13 is the usual floor in the US, and some EU countries require 16 for consent-based processing). Make people confirm it at sign-up (a required checkbox, with the time stored in `profiles`), say so in the terms, and delete accounts you learn belong to younger children. GitHub sign-in already requires 13+.
2. **Terms and privacy notice.** Cover: what is stored (projects, evidence ledgers, usage), that prompts and evidence are sent to AI model providers through the gateway (name them), where the database runs, how long data is kept, how to export and delete it, and who the sub-processors are (Supabase, the model provider, the payment provider). Teams will ask for a data processing agreement.
3. **Email.** Auth emails (sign-in links, invites) are transactional. Any launch or newsletter email needs a working unsubscribe link, your physical postal address, honest subject lines, opt-outs honoured promptly, and consent where the law requires it (EU). A mailing provider that handles this for you is worth it.
4. **Payments.** Next to the buy button show the price, how often it renews, and how to cancel. Get clear consent to the renewal, make cancelling as easy as signing up, and send renewal reminders where state law asks for them. Keep the text in the checkout, not only in the terms.
5. **User content.** If anyone can ever publish something other people see (public projects, shared ledgers beyond a team), register a designated DMCA agent with the US Copyright Office (small fee, renew every 3 years), publish a takedown and repeat-infringer policy, and keep the contact up to date. Until then, keep everything private by default.
6. **Analytics, if you add them.** Prefer privacy-friendly, cookieless analytics with no session replay, no form-field or keystroke capture, and no third-party scripts that load before consent. Update `site/privacy.html` and the site's Content Security Policy in the same change.
7. **Security promises.** Do not claim more than is true (for example "military-grade"). Publish a security contact (`SECURITY.md`, `/.well-known/security.txt`).

## Already handled

- Open-source licence (Apache-2.0) and `NOTICE` with third-party licences.
- KiCad data attribution and share-alike (`site/assets/PARTS-DATA-LICENSE.md`).
- No hosting of vendor datasheets; quotes of 15 words or fewer with a page reference.
- Trademark and non-affiliation statements on the data pages.
- Company contact links limited to public company pages (no personal data).
