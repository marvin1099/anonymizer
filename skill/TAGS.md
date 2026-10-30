# Tag vocabulary

Reference for `anonymizer`. Read on demand — the label tells you what the
detector believed, not what the value is.

| Tag | Detector read it as |
|---|---|
| `PERSON` | full names; unambiguous name parts ("Herrn Peter Schmidt" = "Peter Schmidt") |
| `USERNAME` | logins and account names, e.g. `a.schmidt`, `(m.mustermann)` in timestamps |
| `ORG` | companies, manufacturers, departments |
| `LOC` | places, sites, rooms — sometimes a column header such as "Location" |
| `ADDRESS`, `DOB` | street addresses, dates of birth |
| `EMAIL`, `PHONE` | e-mail, phone/fax, national and international |
| `IBAN`, `BANK_ACCOUNT`, `CREDIT_CARD`, `TAX_ID` | financial and tax identifiers (checksum-validated) |
| `PASSPORT`, `DRIVER_LICENSE`, `LICENSE_PLATE`, `SOCIAL_SECURITY` | official identifiers |
| `IP_ADDRESS`, `MAC_ADDRESS`, `PASSWORD` | technical identifiers |
| `URL` | **catch-all** for anything link-like: IPs, serial numbers, inventory IDs, device names, occasionally a header |
| `ANON_ERROR` | the filter failed — report it, it is not content |

Behaviour worth knowing:

- Numbering is stable and case-insensitive; titles are stripped before matching.
- Over-tagging happens (harmless words, headers). It is the safe direction.
- Rare formats can be missed. If the task depends on a field being anonymized
  and you are unsure, say so instead of asserting.
- Exempt from filtering: the tooling's own directories plus folders listed in
  `~/.config/opencode/anonymizer.json` (file tools only, never shell).
- Never exempt, even inside those: logs, sessions, stored tool output and
  credentials, plus the anonymizer's own mapping file. Reading one needs
  `[ANON:RAW]` from the user; anonymized text looks like normal text, so you
  cannot tell from the output that it was filtered.
