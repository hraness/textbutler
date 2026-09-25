Textbutler can import your Beeper and WhatsApp history as context for each conversation, but it never signs in to either service and holds no Beeper or WhatsApp password or session. Ghostget, a separate local tool, exports that history to a private folder in Textbutler's own format. Textbutler then checks the folder and imports it on your Mac. The two programs do not talk to each other during the import; the folder is the whole handoff. (Textbutler's live inbox and replies also go through Ghostget, but that is a separate path this post does not cover.)

## Who this is for

You already use Beeper, WhatsApp or both, and you want the butler to have the history of a conversation with a friend, a sibling or a group chat. You want that without giving a third app your messaging logins, and without anything leaving your Mac.

The export covers your own history, from accounts you are signed in to. It also contains the other people's messages, since that is what a conversation is.

## What Ghostget does

[Ghostget](https://ghostget.com) is a local command line tool that works with the accounts you are already signed in to on your own computer. For messaging, it can read your Beeper Desktop history and your WhatsApp linked-device history. Ghostget holds the sign-in state and runs the export, and Textbutler never sees that state.

Here Ghostget writes a finished folder of plain text files that describe your accounts, the people in each conversation, the conversations, the messages, reactions, and deletions.

```sh
ghostget beeper export-message-like-me --auth <your-beeper-auth> \
  --output /absolute/private/path/beeper-bundle --json

ghostget whatsapp export-message-like-me --auth <your-whatsapp-auth> \
  --output /absolute/private/path/whatsapp-bundle --json
```

The command names still carry Message Like Me, Textbutler's earlier name, because the format was named then and existing tools depend on it.

## How Textbutler uses it

Textbutler's side is one import command, run with its `messagelikeme` command-line tool, which also keeps the earlier name:

```sh
messagelikeme ingest bundle --input /absolute/private/path/beeper-bundle --json
messagelikeme sources list --json
```

The import reads only the finished folder. It does not start Ghostget, open Beeper or WhatsApp, use the network, or send anything.

### Textbutler defines the format

The folder format is defined in Textbutler's repository, as a small module of types and strict checking functions that does no file, network or messaging work of its own. Ghostget does not keep its own copy of those rules. It depends on Textbutler's module, pinned to one fixed commit, and runs every record it writes through Textbutler's own checks before the folder is finished.

There are two versions:

- **Version 1, for Beeper.** One folder can hold several connected accounts, because Beeper bridges several networks. Each account becomes its own source in Textbutler.
- **Version 2, for WhatsApp.** One folder holds exactly one WhatsApp account, and every address must be a well-formed WhatsApp identifier. Status updates, broadcasts and newsletters are rejected.

Because Ghostget checks its output with Textbutler's code at a fixed commit, the rules change in one place, and Ghostget adopts a change only when its pin is updated.

### Each folder lists hashes for its own files

A bundle is seven files: six line-per-record text files and an index file written last. The index lists each file's record count, byte length and SHA-256 hash, plus one hash over the index itself, computed like this:

```text
bundle hash = SHA-256( canonical JSON of the index, without its integrity section )
```

"Canonical" means one exact spelling of the JSON, so the same content always produces the same bytes and the same hash. Textbutler recomputes all of it before it changes anything in its store. It also refuses a folder that is not private to your user account, contains an extra file, a symbolic link or a hard link, or changes while it is being read. Checking finishes before the store is touched, and the import itself is one database transaction, so a folder that fails is not partly imported.

### Both repositories test the same sample folder

A small synthetic bundle, with invented accounts such as "Synthetic Primary" and a placeholder phone number, is checked into both repositories as identical files:

- Ghostget's tests run its real exporter over the synthetic source with a fixed clock and require the output to match the checked-in folder byte for byte.
- Textbutler's tests import that same checked-in folder and require the index file's SHA-256 to match the value recorded in the test.

If Ghostget's output changes by one byte, its own test fails. If Textbutler's importer stops accepting the checked-in folder, Textbutler's test fails. The two copies are kept identical by hand rather than by a shared check, so a deliberate format change means regenerating the folder in Ghostget and copying it into Textbutler in step.

### Re-importing does not erase history

Each export is a snapshot of what your Mac could see at that moment, and Textbutler treats it that way:

- A later export that leaves out an older message does not delete it from Textbutler.
- An explicit deletion record hides its target, and if the message reappears later it comes back.
- An older snapshot cannot overwrite newer state.

You can run the export again next month, and a smaller window will not throw away what you imported before.

## What you get

Your Beeper and WhatsApp conversations land in Textbutler's private store on your Mac, where its replies can draw on that history, and Textbutler never holds a Beeper or WhatsApp login. `sources list` shows what was imported, and `sources show` reports each source's health.

If you use WhatsApp both natively and through Beeper, Textbutler stops and asks you to name the overlapping Beeper source with `--overlap-source` before it imports the native export. Both sources stay stored. It counts two messages as one only in one-to-one chats where your own number and the other person's number match exactly, and only after at least one unambiguous shared message agrees on sender, time, direction, text and kind. Names, partial numbers, approximate times, group chats and messages without text never count as a match.

## Limits

- **It is not your whole history.** Each export records what the local apps had on your Mac, and says so. The Beeper export marks that it does not claim remote history, and the WhatsApp export marks remote history as incomplete.
- **No media.** Attachments come across as names and types only. Images, audio and video stay where they are.
- **WhatsApp reactions are left out.** The WhatsApp tool Ghostget reads cannot tell whether a reaction was later removed, so Ghostget drops reaction rows and adds a warning when it saw any. An empty reactions file in a WhatsApp bundle means reactions could not be observed.
- **The hashes cover the folder only.** They show the folder was not damaged or edited after Ghostget wrote it. They say nothing about whether the messaging app's data was right or complete.
- **Keep the folder private.** It is not anonymized. Names, phone numbers, message text and who talks to whom are all in it. Do not put it in Git, a shared folder or a cloud drive.

Textbutler is {{SITE_STATUS_LABEL}}. It runs from source on a Mac and has no downloadable app yet; [Introducing Textbutler](/blog/introducing-textbutler) covers what it does today and how to start. Ghostget lists the products that use it on [Built on Ghostget](https://ghostget.com/blog/built-on-ghostget).
