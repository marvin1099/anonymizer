---
name: anonymizer
description: Everything tool output shows you is already anonymized. Use when reading, writing or moving data that may contain personal or firm data (exports, CMDB/HR lists, logs, tickets, configs), when you see placeholders like [PERSON_1], when the user mentions an [ANON:...] marker, or when anonymization looks broken. How to handle the placeholders, write them back, and what to ask for.
---

# Anonymizer

Tool output — files, shell, browser — reaches you anonymized: personal and firm
data is replaced by **handles** such as `[PERSON_1]`.

**A handle is not missing data.** Report with the handles you see. Never invent
one, never try to resolve one; nothing in your toolset does that.

## Handles

- Same value → same handle, across files, tool calls and restarts.
- The label is a guess: `[URL_3]` may hold an IP, a serial or an inventory ID.
  Don't read meaning into it — ask when it decides the task. Vocabulary: `TAGS.md`.
- Ambiguity stays plain text on purpose (two people, one first name). Leave it.
- `[ANON_ERROR]` means the filter failed, not content. Report it.

## Writing moves data

Handles in tool inputs are replaced with the real values before the call runs:

| You write | What happens |
|---|---|
| `read /tmp/[URL_3].csv` | opens that file |
| content `[PERSON_1]` | the real name lands on disk |
| `[PERSON_2]` where the source had `[PERSON_1]` | the two values swap |

So move handles, not values: copying a handle copies the value, swapping two
handles swaps the data. For literal `[PERSON_1]` text in a file, write
`[[PERSON_1]]`.

Direction matters: everything coming **in** is anonymized — script output,
shell output, file reads alike. What you write goes out unfiltered, so a
handle inside a script or config lands there as the real value. That is what
makes moving data work; treat scripts you create as holding real values.

## Ask the user

Ask, rather than work around it, when:

- raw data would help and the user knows the file is harmless. Say exactly:
  *"Start your next message with `[ANON:OFF]` (single brackets). It stays
  off until you send a message without the marker."*
- a file must contain literal handle text — confirm the `[[...]]` escaping.
- a handle's meaning decides what you do next.
- anonymization looks broken — a restart of OpenCode fixes it.

Only the user's own message is read for markers. You cannot set them yourself.

## Markers the user can type

| Marker | Effect |
|---|---|
| `[ANON:OFF]` | output unfiltered, until the next message without a marker |
| `[ANON:ON]` | filtering back on (any marker-less message does it too) |
| `[ANON:FORCED]` / `[ANON:FORCE]` | also filter exempt paths, this request only |
| `[ANON:S-OFF]` | raw for exactly one tool result |
| `[ANON:S-FORCE]` | filtering for exactly one tool result |
| `[ANON:RAW]` | exempt the always-protected files only (logs, sessions, credentials) |

Single brackets trigger; `[[...]]` is literal text. `S-` and `[ANON:RAW]` stay visible
in the message, the others are removed before you see them.

## Cost

Detection runs ≈0.3 s per KB, so a large dump takes a minute. Read with
`offset`/`limit` instead. Progress toasts appear meanwhile.
