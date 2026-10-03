# G2 Implementation

## Context

Feature Requst: [Export and Import an AudioBook's Bookmarks](https://github.com/CMU-17695/audiobookshelf/issues/2)

## Running Instructions

### Unit Tests

To run the bookmark unit tests in a Powershell terminal:
```
$env:Path = "C:\Program Files\nodejs;$env:Path"
npm.cmd test -- --grep "MeController bookmarks"
```

To run the full server test suite:
```
npm.cmd test
```
### Manual Integration Tests

To run the full client and server, follow the instructions in [Development Commands](./readme.md#development-commands). After starting the server, run the following tests:

#### Export

1. Upload a new audio file or open an existing one.
2. Test previous functionality including: adding bookmarks, editing, and removing.
3. Once a few bookmarks are added, select "Export Bookmarks" in the drop-down menu.
    - A folder selection will appear, name the file path and select save. A pop up window should appear confirming the bookmarks have been exported.
4. Verify the json file is in the expected location and check that the output matches the viewed bookmarks.
5. Modify the bookmarks in some way, either adding a new one or editing an existing one. Re-export the file, changing the name.
5. Verify the json file is in the expection location, the time is different, and the recent changes are present.

#### Import

1. Delete the existing bookmarks for the audio file.
2. Select "Import Bookmarks" in the drop down menu.
3. Select "Choose a bookmark JSON file"
    - A folder selection will appear. Navigate to the previously exported files and select open. Four
  new bookmarks should appear in a preview window.
4. Select "Import", a popup should appear confirming the bookmarks have been imported.
5. Open the file that was imported. Manually edit the `schemaVersion` to `2` and attempt to import. A failure pop-up should appear.
6. Set the `schemaVersion` back to `1` and modify the `libraryItemId` then attempt to import. A failure pop-up should appear.
7. Reset the `libraryItemId` back to where it was. Now modify the titles of at least two of the bookmarks and import the file. This should present a list of conflicting bookmarks. For one, select "Keep existing" and for the other select "Replace". After selecting "Import", view the bookmarks again. They should match the user input.
8. Add a bookmark to the file manually with a time longer than the audiofile and attempt to import. A failure pop-up should appear.

## What Changed From the RFC

One difference between the final implementation and the RFC was the scope of impacted files:

- Instead of modifying `client/components/modals/BookmrksModal.vue`, a new `BookmarksImportModal.vue` was created.
- `client/strings/en-us.json`and `ApiRouter.js` were updated with the newest API calls.
- A new test file (`test/server/controllers/MeController.test.js`) to encompass both existing and new bookmark functionality. While not explicitly called out, this was expected as a test did not exist previously.
- `server/models/User.js` updated existing functions to provide new/optional inputs to handle some of import logic. For example, `createBookmark()` previously assumed the time, but now it can apply the time from the uploaded file.

There were two other behaviorial changes that I did not define in the RFC:

- Both the import and export apply a limit of 100 bookmarks at a time. This is specified by a global variable both features can access.
- For import, an additional check was added after loading in the file defined in `validateBookmarkImport`. While I had called out some validation was required, this added steps I had not considered. For example, it will confirm it's a valid file, apply the maximum limit, and check for duplicate timestamps. These checks are not required for the other bookmark functions, so it makes sense to apply them only at the import step.

## Next Steps

Not in scope for this assignment, but one next step could be more thorough testing by other users to further validate the new features.