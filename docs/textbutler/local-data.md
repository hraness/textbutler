# Local data

Textbutler keeps settings, contact memory, reply journals and setup records in
`~/Library/Application Support/Textbutler`, unless you select another data
directory. These files are private to the Mac user. XCB and Ghostget keep their
own accounts and credentials in their separately configured state directories.

iMessage setup retains one small account binding so a repeated setup cannot
silently authorize a different account under the same name. Failed attempts do
not replace that binding. Setup results contain bounded progress and digests;
they contain no message bodies or credentials.

## Remove Textbutler data

Use `textbutler daemon uninstall` and stop the menu companion before removing
local data. Confirm that Textbutler and its connector operations have stopped.
If an operation has an uncertain outcome, reconcile it and retain the evidence
needed to settle that operation first.

To erase an installation, the owner can then delete its complete Textbutler
data directory. This removes settings, contact memory, journals, setup results
and the iMessage account binding. It does not delete Messages history, Ghostget
or XCB accounts, or macOS permission grants. Removing individual binding or
custody records is not a supported way to replace an account or retry a failed
operation. Reinstalling the command and uninstalling the background service
both preserve data by default.
