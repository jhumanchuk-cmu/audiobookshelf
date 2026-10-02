const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const MeController = require('../../../server/controllers/MeController')
const SocketAuthority = require('../../../server/SocketAuthority')

describe('MeController bookmarks', () => {
  let libraryItemId
  let user

  beforeEach(async () => {
    // Initialize a fresh in-memory SQLite database so bookmark changes cannot leak between tests.
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    // Create a book and library item for the handlers to look up and authorize.
    const library = await Database.libraryModel.create({ name: 'Bookmark Test Library', mediaType: 'book' })
    const libraryFolder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    const book = await Database.bookModel.create({
      title: 'Bookmark Test Book',
      duration: 100,
      audioFiles: [],
      tags: ['bookmark-test'],
      narrators: [],
      genres: [],
      chapters: []
    })
    const libraryItem = await Database.libraryItemModel.create({
      path: '/books/bookmark-test',
      isFile: false,
      libraryFiles: [],
      mediaId: book.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    libraryItemId = libraryItem.id

    // Give the test user access to the fixture item and start with no bookmarks.
    const permissions = Database.userModel.getDefaultPermissionsForUserType('user')
    permissions.accessAllLibraries = true
    permissions.accessAllTags = true
    user = await Database.userModel.create({
      username: 'bookmark-test-user',
      pash: 'hash',
      token: 'token',
      type: 'user',
      isActive: true,
      permissions,
      bookmarks: [],
      extraData: {}
    })

    // Keep controller tests independent of an active Socket.IO server.
    sinon.stub(SocketAuthority, 'clientEmitter')
  })

  afterEach(async () => {
    // Restore socket stubs and clear the in-memory database between tests.
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  it('returns all of the current user bookmarks as copies', () => {
    // The all-bookmarks endpoint includes bookmarks for every library item without exposing stored objects.
    user.bookmarks = [
      { libraryItemId, time: 12, title: 'First bookmark', createdAt: 100 },
      { libraryItemId: 'another-library-item', time: 34, title: 'Second bookmark', createdAt: 200 }
    ]
    const response = { json: sinon.spy() }

    MeController.getAllBookmarks({ user }, response)

    const returnedBookmarks = response.json.firstCall.args[0].bookmarks
    expect(returnedBookmarks).to.deep.equal(user.bookmarks)
    expect(returnedBookmarks).to.not.equal(user.bookmarks)
    expect(returnedBookmarks[0]).to.not.equal(user.bookmarks[0])
  })

  it('returns only bookmarks for the requested library item', async () => {
    // The item-specific endpoint excludes bookmarks belonging to other library items.
    user.bookmarks = [
      { libraryItemId, time: 12, title: 'Matching bookmark', createdAt: 100 },
      { libraryItemId: 'another-library-item', time: 34, title: 'Unrelated bookmark', createdAt: 200 }
    ]
    const response = { json: sinon.spy() }

    await MeController.getBookmarksForLibraryItem({ params: { libraryItemId }, user }, response)

    expect(response.json.firstCall.args[0].bookmarks).to.deep.equal([user.bookmarks[0]])
    expect(response.json.firstCall.args[0].bookmarks[0]).to.not.equal(user.bookmarks[0])
  })

  it('finds a bookmark by library item and timestamp', () => {
    // findBookmark identifies an entry by both its library item and playback time.
    const bookmark = { libraryItemId, time: 12, title: 'Find me', createdAt: 100 }
    user.bookmarks = [bookmark]

    expect(user.findBookmark(libraryItemId, 12)).to.equal(bookmark)
    expect(user.findBookmark('another-library-item', 12)).to.be.undefined
    expect(user.findBookmark(libraryItemId, 99)).to.be.undefined
  })

  it('checks bookmark item access, title, and finite in-range timestamps', async () => {
    // Shared validation accepts a well-formed bookmark and rejects invalid titles or positions.
    const validResult = await MeController.checkBookmarks(libraryItemId, user, { time: 42, title: 'A valid bookmark' })
    expect(validResult.status).to.be.undefined

    const invalidTimeResults = await Promise.all([
      MeController.checkBookmarks(libraryItemId, user, { time: Number.NaN, title: 'Invalid time' }),
      MeController.checkBookmarks(libraryItemId, user, { time: Number.POSITIVE_INFINITY, title: 'Invalid time' }),
      MeController.checkBookmarks(libraryItemId, user, { time: -1, title: 'Invalid time' }),
      MeController.checkBookmarks(libraryItemId, user, { time: 101, title: 'Invalid time' })
    ])
    expect(invalidTimeResults.map((result) => result.error)).to.deep.equal(Array(4).fill('Invalid time'))

    const invalidTitleResult = await MeController.checkBookmarks(libraryItemId, user, { time: 42, title: 123 })
    expect(invalidTitleResult.error).to.equal('Invalid title')
  })

  it('formats bookmark export data with a version, item ID, timestamp, and copied entries', () => {
    // The formatter emits the v1 export contract without exposing stored bookmark objects.
    sinon.stub(Date.prototype, 'toISOString').returns('2026-10-02T12:00:00.000Z')
    const bookmark = { libraryItemId, time: 12, title: 'Export me', createdAt: 100 }

    const output = MeController.formatBookmarkOutput(libraryItemId, [bookmark])

    expect(output).to.deep.equal({
      schemaVersion: 1,
      libraryItemId,
      exportedAt: '2026-10-02T12:00:00.000Z',
      bookmarks: [bookmark]
    })
    expect(output.bookmarks[0]).to.not.equal(bookmark)
  })

  it('limits exported data to 100 bookmarks', () => {
    // Bookmark entries beyond the export limit are omitted from the generated file.
    const bookmarks = Array.from({ length: 105 }, (_, index) => ({
      libraryItemId,
      time: index,
      title: `Bookmark ${index}`,
      createdAt: index
    }))

    const output = MeController.formatBookmarkOutput(libraryItemId, bookmarks)

    expect(output.bookmarks).to.have.lengthOf(100)
    expect(output.bookmarks[0].title).to.equal('Bookmark 0')
    expect(output.bookmarks[99].title).to.equal('Bookmark 99')
  })

  it('exports the current user bookmarks as a JSON attachment', async () => {
    // The download endpoint uses the same access-filtered bookmark set as item retrieval.
    user.bookmarks = [{ libraryItemId, time: 12, title: 'Download me', createdAt: 100 }]
    const response = {
      setHeader: sinon.spy(),
      type: sinon.stub().returnsThis(),
      send: sinon.spy()
    }

    await MeController.exportBookmark({ params: { id: libraryItemId }, user }, response)

    expect(response.setHeader.calledWith('Content-Disposition', `attachment; filename="bookmarks-${libraryItemId}.json"`)).to.be.true
    expect(response.type.calledWith('application/json')).to.be.true
    expect(JSON.parse(response.send.firstCall.args[0]).bookmarks).to.deep.equal(user.bookmarks)
  })

  it('creates, retrieves, updates, and removes a bookmark', async () => {
    // Creating a bookmark persists it and returns the created bookmark.
    const createResponse = { json: sinon.spy() }
    await MeController.createBookmark({
      params: { id: libraryItemId },
      body: { time: 42, title: 'A useful moment' },
      user
    }, createResponse)

    expect(createResponse.json.calledOnce).to.be.true
    expect(createResponse.json.firstCall.args[0]).to.include({
      libraryItemId,
      time: 42,
      title: 'A useful moment'
    })
    expect(user.bookmarks).to.have.lengthOf(1)

    // The item-specific read returns only the current user's bookmarks for this item.
    const getResponse = { json: sinon.spy() }
    await MeController.getBookmarksForLibraryItem({ params: { libraryItemId }, user }, getResponse)
    expect(getResponse.json.firstCall.args[0].bookmarks).to.deep.equal(user.bookmarks)

    // Updating changes the existing bookmark title in both the response and persisted user.
    const updateResponse = { json: sinon.spy() }
    await MeController.updateBookmark({
      params: { id: libraryItemId },
      body: { time: 42, title: 'Updated moment' },
      user
    }, updateResponse)
    expect(updateResponse.json.firstCall.args[0].title).to.equal('Updated moment')
    expect(user.bookmarks[0].title).to.equal('Updated moment')

    // Removing returns success and leaves no bookmark; all three mutations notify clients.
    const removeResponse = { sendStatus: sinon.spy() }
    await MeController.removeBookmark({ params: { id: libraryItemId, time: '42' }, user }, removeResponse)
    expect(removeResponse.sendStatus.calledWith(200)).to.be.true
    expect(user.bookmarks).to.be.empty
    expect(SocketAuthority.clientEmitter.callCount).to.equal(3)
  })

  it('rejects a bookmark with an invalid title without persisting it', async () => {
    // Invalid input returns a client error without changing bookmarks or emitting an update.
    const response = {
      status: sinon.stub().returnsThis(),
      send: sinon.spy()
    }

    await MeController.createBookmark({
      params: { id: libraryItemId },
      body: { time: 42, title: '' },
      user
    }, response)

    expect(response.status.calledWith(400)).to.be.true
    expect(response.send.calledWith('Invalid title')).to.be.true
    expect(user.bookmarks).to.be.empty
    expect(SocketAuthority.clientEmitter.called).to.be.false
  })
})