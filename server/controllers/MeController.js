const { Request, Response } = require('express')
const { Op } = require('sequelize')
const Logger = require('../Logger')
const SocketAuthority = require('../SocketAuthority')
const Database = require('../Database')
const { sort } = require('../libs/fastSort')
const { toNumber, isUUID } = require('../utils/index')
const userStats = require('../utils/queries/userStats')
const parseUserAgent = require('../utils/parsers/parseUserAgent')

// Maximum number of bookmarks that can be exported or imported in a single file. This limit is
// enforced to prevent excessively large files and to ensure performance and stability during
// bookmark operations.
const MAX_BOOKMARKS_PER_FILE = 100

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef {Request & RequestUserObject} RequestWithUser
 */

class MeControllerClass {
  constructor() {}

  /**
   * GET: /api/me
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  getCurrentUser(req, res) {
    res.json(req.user.toOldJSONForBrowser())
  }

  /**
   * GET: /api/me/sessions
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getSessions(req, res) {
    const page = Math.max(0, toNumber(req.query.page, 0))
    const itemsPerPage = Math.max(1, toNumber(req.query.itemsPerPage, 10))

    if (req.user.isGuest) {
      return res.json({ sessions: [], total: 0, numPages: 0, page, itemsPerPage })
    }

    const refreshToken = req.cookies.refresh_token || req.headers['x-refresh-token']
    const { rows, count } = await Database.sessionModel.findAndCountAll({
      where: {
        userId: req.user.id,
        expiresAt: { [Op.gt]: new Date() }
      },
      order: [['updatedAt', 'DESC']],
      limit: itemsPerPage,
      offset: itemsPerPage * page
    })

    res.json({
      total: count,
      numPages: Math.ceil(count / itemsPerPage),
      page,
      itemsPerPage,
      sessions: rows.map((session) => ({
        id: session.id,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        // For display convenience
        deviceInfo: parseUserAgent(session.userAgent),
        createdAt: session.createdAt?.valueOf() ?? null,
        updatedAt: session.updatedAt?.valueOf() ?? null,
        current: !!refreshToken && (session.refreshToken === refreshToken || session.lastRefreshToken === refreshToken)
      }))
    })
  }

  /**
   * DELETE: /api/me/sessions/:id
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async deleteSession(req, res) {
    if (req.user.isGuest) {
      return res.sendStatus(403)
    }

    if (!isUUID(req.params.id)) {
      return res.sendStatus(400)
    }

    const session = await Database.sessionModel.findOne({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    })

    if (!session) {
      return res.sendStatus(404)
    }

    await Database.sessionModel.destroy({ where: { id: session.id } })
    Logger.info(`[MeController] User ${req.user.username} deleted auth session ${session.id}`)

    res.sendStatus(200)
  }

  /**
   * GET: /api/me/progress
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  getAllMediaProgress(req, res) {
    const mediaProgress = req.user.mediaProgresses?.map((mp) => mp.getOldMediaProgress()) || []
    res.json({ mediaProgress })
  }

  /**
   * GET: /api/me/bookmarks
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  getAllBookmarks(req, res) {
    const bookmarks = req.user.bookmarks?.map((bookmark) => ({ ...bookmark })) || []
    res.json({ bookmarks })
  }

  /**
   * GET: /api/me/bookmarks/:libraryItemId
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async checkBookmarks(libraryItemId, user, bookmark = null) {
    // Resolve the item before checking permissions or bookmark details.
    const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
    if (!libraryItem) {
      return { status: 404, error: 'Library item not found' }
    }

    // Refuse bookmark operations for items outside the user's permissions.
    if (!user.checkCanAccessLibraryItem(libraryItem)) {
      Logger.error(`[MeController] User "${user.username}" attempted to access bookmarks for library item "${libraryItemId}" without access`)
      return { status: 403, error: 'Forbidden' }
    }

    // Validate one bookmark or a batch against this item's duration and expected shape.
    if (bookmark) {
      const duration = libraryItem.media?.getPlaybackDuration?.() ?? libraryItem.media?.duration
      const bookmarks = Array.isArray(bookmark) ? bookmark : [bookmark]
      for (const entry of bookmarks) {
        if (!entry || typeof entry !== 'object' || (Array.isArray(bookmark) ? entry.libraryItemId !== libraryItem.id : entry.libraryItemId && entry.libraryItemId !== libraryItem.id)) {
          return { status: 400, error: 'Invalid bookmark entry' }
        }
        if (!Number.isFinite(entry.time) || entry.time < 0 || !Number.isFinite(duration) || entry.time > duration) {
          Logger.error('[MeController] Invalid bookmark time', entry.time)
          return { status: 400, error: 'Invalid time' }
        }
        if ((Array.isArray(bookmark) || Object.prototype.hasOwnProperty.call(entry, 'title')) && (!entry.title || typeof entry.title !== 'string')) {
          Logger.error('[MeController] Invalid bookmark title', entry.title)
          return { status: 400, error: 'Invalid title' }
        }
        if (entry.createdAt !== undefined && !Number.isFinite(entry.createdAt)) {
          return { status: 400, error: 'Invalid bookmark creation time' }
        }
      }
    }

    return { libraryItem }
  }

  /**
   * GET: /api/me/bookmarks/:libraryItemId
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getBookmarksForLibraryItem(req, res) {
    const result = await MeController.checkBookmarks(req.params.libraryItemId, req.user)
    if (result.status) {
      return res.sendStatus(result.status)
    }
    const bookmarks = req.user.bookmarks?.filter((bookmark) => bookmark.libraryItemId === result.libraryItem.id).map((bookmark) => ({ ...bookmark })) || []
    res.json({ bookmarks })
  }

  /**
   * Format versioned bookmark export data.
   *
   * @param {string} libraryItemId
   * @param {import('../models/User').AudioBookmarkObject[]} bookmarks
   * @returns {{ schemaVersion: number, libraryItemId: string, exportedAt: string, bookmarks: import('../models/User').AudioBookmarkObject[] }}
   */
  formatBookmarkOutput(libraryItemId, bookmarks) {
    // Attach v1 metadata and copy no more than the supported export limit.
    return {
      schemaVersion: 1,
      libraryItemId,
      exportedAt: new Date().toISOString(),
      bookmarks: bookmarks.slice(0, MAX_BOOKMARKS_PER_FILE).map((bookmark) => ({ ...bookmark }))
    }
  }

  /**
    * Validate the versioned file envelope and its record collection.
   *
   * @param {object} bookmarkFile
   * @param {string} libraryItemId
   * @returns {{ bookmarks?: object[], error?: string }}
   */
  validateBookmarkImport(bookmarkFile, libraryItemId) {
    // Reject non-object input before reading versioned file properties.
    if (!bookmarkFile || typeof bookmarkFile !== 'object' || Array.isArray(bookmarkFile)) {
      return { error: 'Invalid bookmark file' }
    }
    // Confirm the file's schema version, target item, and creation timestamp.
    if (bookmarkFile.schemaVersion !== 1 || bookmarkFile.libraryItemId !== libraryItemId || typeof bookmarkFile.exportedAt !== 'string' || !Number.isFinite(Date.parse(bookmarkFile.exportedAt))) {
      return { error: 'Unsupported or invalid bookmark file' }
    }
    // Enforce the same maximum supported by export.
    if (!Array.isArray(bookmarkFile.bookmarks) || bookmarkFile.bookmarks.length > MAX_BOOKMARKS_PER_FILE) {
      return { error: `Bookmark file must contain no more than ${MAX_BOOKMARKS_PER_FILE} bookmarks` }
    }

    // Check record shape and reject duplicate timestamps; checkBookmarks owns bookmark field validation.
    const seenTimes = new Set()
    for (const bookmark of bookmarkFile.bookmarks) {
      if (!bookmark || typeof bookmark !== 'object' || Array.isArray(bookmark)) {
        return { error: 'Invalid bookmark entry' }
      }
      if (seenTimes.has(bookmark.time)) {
        return { error: `Duplicate bookmark timestamp ${bookmark.time}; each timestamp can only appear once in the file` }
      }
      seenTimes.add(bookmark.time)
    }

    // Return copies so later comparison or import work cannot mutate the parsed payload.
    return { bookmarks: bookmarkFile.bookmarks.map((bookmark) => ({ ...bookmark })) }
  }

  /**
   * Compare imported entries with the current bookmarks for one item.
   *
   * @param {object[]} importedBookmarks
   * @param {object[]} currentBookmarks
   */
  compareBookmarks(importedBookmarks, user) {
    // Classify each import by timestamp and title without mutating either input list.
    const comparison = { newBookmarks: [], conflicts: [], matching: [] }

    for (const importedBookmark of importedBookmarks) {
      const existingBookmark = user.findBookmark(importedBookmark.libraryItemId, importedBookmark.time)
      if (!existingBookmark) {
        comparison.newBookmarks.push(importedBookmark)
      } else if (existingBookmark.title === importedBookmark.title) {
        comparison.matching.push({ existing: existingBookmark, imported: importedBookmark })
      } else {
        comparison.conflicts.push({ existing: existingBookmark, imported: importedBookmark })
      }
    }

    return comparison
  }

  /**
   * Send the new, conflicting, and matching bookmark results to the preview UI.
   *
   * @param {{ newBookmarks: object[], conflicts: object[], matching: object[] }} comparison
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async previewBookmarkUpdates(comparison, req, res) {
    if (req.body.action !== 'apply') {
      // Return only the preview details needed for user review and conflict choices.
      return res.json({
        newBookmarks: comparison.newBookmarks,
        conflicts: comparison.conflicts,
        matchingCount: comparison.matching.length
      })
    }

    // Keep only conflicts the user explicitly chose to replace.
    const conflictChoices = req.body.conflictChoices || {}
    const replacements = comparison.conflicts.filter((conflict) => conflictChoices[String(conflict.imported.time)] === 'replace')
    const additions = comparison.newBookmarks
    if (!additions.length && !replacements.length) {
      return res.json({ addedCount: 0, replacedCount: 0, unchangedCount: comparison.matching.length + comparison.conflicts.length })
    }

    // Snapshot the list so failed persistence can restore the current in-memory state.
    const user = req.user
    const originalBookmarks = (user.bookmarks || []).map((bookmark) => ({ ...bookmark }))
    try {
      // Apply all selected changes in one transaction using the existing bookmark model operations.
      await Database.sequelize.transaction(async (transaction) => {
        for (const bookmark of additions) {
          await user.createBookmark(req.params.id, bookmark.time, bookmark.title, bookmark.createdAt ?? Date.now(), { transaction })
        }
        for (const conflict of replacements) {
          const importedBookmark = conflict.imported
          const updatedBookmark = await user.updateBookmark(
            req.params.id,
            importedBookmark.time,
            importedBookmark.title,
            importedBookmark.createdAt,
            { transaction }
          )
          if (!updatedBookmark) {
            throw new Error(`Bookmark at ${importedBookmark.time} was not found during import`)
          }
        }
      })
    } catch (error) {
      // Restore memory after the database transaction rolls back.
      user.bookmarks = originalBookmarks
      user.changed('bookmarks', true)
      Logger.error('[MeController] Failed to persist imported bookmarks', error)
      return res.status(500).send('Failed to save bookmarks')
    }

    // Notify connected clients after the transaction commits.
    SocketAuthority.clientEmitter(user.id, 'user_updated', user.toOldJSONForBrowser())
    return res.json({
      addedCount: additions.length,
      replacedCount: replacements.length,
      unchangedCount: comparison.matching.length + comparison.conflicts.length - replacements.length
    })
  }

  /**
   * POST: /api/me/item/:id/bookmarks/import
   * Preview entries with action "preview"; apply selected conflicts with action "apply".
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async importBookmarks(req, res) {
    // Accept only the two supported stages of the import workflow.
    if (req.body?.action && !['preview', 'apply'].includes(req.body.action)) {
      return res.status(400).send('Invalid import action')
    }

    // Validate the file envelope before passing entries to the shared item and bookmark checks.
    const validation = MeController.validateBookmarkImport(req.body?.bookmarkFile, req.params.id)
    if (validation.error) {
      return res.status(400).send(validation.error)
    }
    // Resolve item access and validate every bookmark in one database lookup.
    const bookmarksCheck = await MeController.checkBookmarks(req.params.id, req.user, validation.bookmarks)
    if (bookmarksCheck.status) {
      return bookmarksCheck.status === 400 ? res.status(400).send(bookmarksCheck.error) : res.sendStatus(bookmarksCheck.status)
    }

    const comparison = MeController.compareBookmarks(validation.bookmarks, req.user)
    return MeController.previewBookmarkUpdates(comparison, req, res)
  }

  /**
   * GET: /api/me/item/:id/bookmarks/export
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async exportBookmark(req, res) {
    // Reuse item existence and access checks before preparing the download.
    const result = await MeController.checkBookmarks(req.params.id, req.user)
    if (result.status) {
      return res.sendStatus(result.status)
    }

    // Serialize only this item's bookmarks and mark the response as a JSON attachment.
    const bookmarks = req.user.bookmarks?.filter((bookmark) => bookmark.libraryItemId === result.libraryItem.id) || []
    const output = MeController.formatBookmarkOutput(req.params.id, bookmarks)
    res.setHeader('Content-Disposition', `attachment; filename="bookmarks-${req.params.id}.json"`)
    // Send a downloadable, pretty-printed JSON representation.
    res.type('application/json').send(JSON.stringify(output, null, 2))
  }

  /**
   * GET: /api/me/listening-sessions
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getListeningSessions(req, res) {
    const listeningSessions = await this.getUserListeningSessionsHelper(req.user.id)

    const itemsPerPage = toNumber(req.query.itemsPerPage, 10) || 10
    const page = toNumber(req.query.page, 0)

    const start = page * itemsPerPage
    const sessions = listeningSessions.slice(start, start + itemsPerPage)

    const payload = {
      total: listeningSessions.length,
      numPages: Math.ceil(listeningSessions.length / itemsPerPage),
      page,
      itemsPerPage,
      sessions
    }

    res.json(payload)
  }

  /**
   * GET: /api/me/item/listening-sessions/:libraryItemId/:episodeId
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getItemListeningSessions(req, res) {
    const libraryItem = await Database.libraryItemModel.getExpandedById(req.params.libraryItemId)
    const episode = await Database.podcastEpisodeModel.findByPk(req.params.episodeId)

    if (!libraryItem || (libraryItem.isPodcast && !episode)) {
      Logger.error(`[MeController] Media item not found for library item id "${req.params.libraryItemId}"`)
      return res.sendStatus(404)
    }

    // Check if user has access to this library item
    if (!req.user.checkCanAccessLibraryItem(libraryItem)) {
      Logger.error(`[MeController] User "${req.user.username}" attempted to access listening sessions for library item "${req.params.libraryItemId}" without access`)
      return res.sendStatus(403)
    }

    const mediaItemId = episode?.id || libraryItem.mediaId
    let listeningSessions = await this.getUserItemListeningSessionsHelper(req.user.id, mediaItemId)

    const itemsPerPage = toNumber(req.query.itemsPerPage, 10) || 10
    const page = toNumber(req.query.page, 0)

    const start = page * itemsPerPage
    const sessions = listeningSessions.slice(start, start + itemsPerPage)

    const payload = {
      total: listeningSessions.length,
      numPages: Math.ceil(listeningSessions.length / itemsPerPage),
      page,
      itemsPerPage,
      sessions
    }

    res.json(payload)
  }

  /**
   * GET: /api/me/listening-stats
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getListeningStats(req, res) {
    const listeningStats = await this.getUserListeningStatsHelpers(req.user.id)
    res.json(listeningStats)
  }

  /**
   * GET: /api/me/progress/:id/:episodeId?
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getMediaProgress(req, res) {
    const mediaProgress = req.user.getOldMediaProgress(req.params.id, req.params.episodeId || null)
    if (!mediaProgress) {
      return res.sendStatus(404)
    }
    res.json(mediaProgress)
  }

  /**
   * DELETE: /api/me/progress/:id
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async removeMediaProgress(req, res) {
    // Verify the media progress belongs to the current user
    const mediaProgress = req.user.mediaProgresses.find((mp) => mp.id === req.params.id)
    if (!mediaProgress) {
      Logger.error(`[MeController] Media progress not found or does not belong to user "${req.user.username}"`)
      return res.sendStatus(404)
    }

    await Database.mediaProgressModel.removeById(req.params.id)
    req.user.mediaProgresses = req.user.mediaProgresses.filter((mp) => mp.id !== req.params.id)

    SocketAuthority.clientEmitter(req.user.id, 'user_updated', req.user.toOldJSONForBrowser())
    res.sendStatus(200)
  }

  /**
   * PATCH: /api/me/progress/:libraryItemId/:episodeId?
   * TODO: Update to use mediaItemId and mediaItemType
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async createUpdateMediaProgress(req, res) {
    const progressUpdatePayload = {
      ...req.body,
      libraryItemId: req.params.libraryItemId,
      episodeId: req.params.episodeId
    }
    const mediaProgressResponse = await req.user.createUpdateMediaProgressFromPayload(progressUpdatePayload)
    if (mediaProgressResponse.error) {
      return res.status(mediaProgressResponse.statusCode || 400).send(mediaProgressResponse.error)
    }

    SocketAuthority.clientEmitter(req.user.id, 'user_updated', req.user.toOldJSONForBrowser())
    res.sendStatus(200)
  }

  /**
   * PATCH: /api/me/progress/batch/update
   * TODO: Update to use mediaItemId and mediaItemType
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async batchUpdateMediaProgress(req, res) {
    const itemProgressPayloads = req.body
    if (!itemProgressPayloads?.length) {
      return res.status(400).send('Missing request payload')
    }

    let hasUpdated = false
    for (const itemProgress of itemProgressPayloads) {
      const mediaProgressResponse = await req.user.createUpdateMediaProgressFromPayload(itemProgress)
      if (mediaProgressResponse.error) {
        Logger.error(`[MeController] batchUpdateMediaProgress: ${mediaProgressResponse.error}`)
        continue
      } else {
        hasUpdated = true
      }
    }

    if (hasUpdated) {
      SocketAuthority.clientEmitter(req.user.id, 'user_updated', req.user.toOldJSONForBrowser())
    }

    res.sendStatus(200)
  }

  /**
   * POST: /api/me/item/:id/bookmark
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async createBookmark(req, res) {
    const validation = await MeController.checkBookmarks(req.params.id, req.user, req.body)
    if (validation.status) {
      return validation.status === 400 ? res.status(400).send(validation.error) : res.sendStatus(validation.status)
    }

    const { time, title } = req.body
    const bookmark = await req.user.createBookmark(req.params.id, time, title)
    SocketAuthority.clientEmitter(req.user.id, 'user_updated', req.user.toOldJSONForBrowser())
    res.json(bookmark)
  }

  /**
   * PATCH: /api/me/item/:id/bookmark
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async updateBookmark(req, res) {
    const validation = await MeController.checkBookmarks(req.params.id, req.user, req.body)
    if (validation.status) {
      return validation.status === 400 ? res.status(400).send(validation.error) : res.sendStatus(validation.status)
    }

    const { time, title } = req.body
    const bookmark = await req.user.updateBookmark(req.params.id, time, title)
    if (!bookmark) {
      Logger.error(`[MeController] updateBookmark not found for library item id "${req.params.id}" and time "${time}"`)
      return res.sendStatus(404)
    }

    SocketAuthority.clientEmitter(req.user.id, 'user_updated', req.user.toOldJSONForBrowser())
    res.json(bookmark)
  }

  /**
   * DELETE: /api/me/item/:id/bookmark/:time
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async removeBookmark(req, res) {
    const time = Number(req.params.time)
    const validation = await MeController.checkBookmarks(req.params.id, req.user, { time })
    if (validation.status) {
      return validation.status === 400 ? res.status(400).send(validation.error) : res.sendStatus(validation.status)
    }

    if (!req.user.findBookmark(req.params.id, time)) {
      Logger.error(`[MeController] removeBookmark not found`)
      return res.sendStatus(404)
    }

    await req.user.removeBookmark(req.params.id, time)

    SocketAuthority.clientEmitter(req.user.id, 'user_updated', req.user.toOldJSONForBrowser())
    res.sendStatus(200)
  }

  /**
   * PATCH: /api/me/password
   * User change password. Requires current password.
   * Guest users cannot change password.
   *
   * Invalidates all other JWT sessions for the user. If using x-refresh-token, returns new tokens for the current session.
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async updatePassword(req, res) {
    if (req.user.isGuest) {
      Logger.error(`[MeController] Guest user "${req.user.username}" attempted to change password`)
      return res.sendStatus(403)
    }

    const { password, newPassword } = req.body
    if ((typeof password !== 'string' && password !== null) || (typeof newPassword !== 'string' && newPassword !== null)) {
      return res.status(400).send('Missing or invalid password or new password')
    }

    const result = await this.auth.localAuthStrategy.changePassword(req.user, password, newPassword)

    if (result.error) {
      return res.status(400).send(result.error)
    }

    const shouldReturnTokens = !!req.headers['x-refresh-token']
    const newTokens = await this.auth.invalidateJwtSessionsForUser(req.user, req, res)

    if (newTokens?.accessToken) {
      Logger.info(`[MeController] Invalidated other JWT sessions for user ${req.user.username} after password change`)
      if (shouldReturnTokens) {
        return res.json({
          success: true,
          user: {
            accessToken: newTokens.accessToken,
            refreshToken: newTokens.refreshToken
          }
        })
      }
    } else {
      Logger.info(`[MeController] Invalidated all JWT sessions for user ${req.user.username} after password change`)
    }

    res.sendStatus(200)
  }

  /**
   * GET: /api/me/items-in-progress
   * Pull items in progress for all libraries
   * Used in Android Auto in progress list since there is no easy library selection
   * TODO: Update to use mediaItemId and mediaItemType. Use sort & limit in query
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getAllLibraryItemsInProgress(req, res) {
    const limit = !isNaN(req.query.limit) ? Number(req.query.limit) || 25 : 25

    const mediaProgressesInProgress = req.user.mediaProgresses.filter((mp) => !mp.isFinished && (mp.currentTime > 0 || mp.ebookProgress > 0))

    const libraryItemsIds = [...new Set(mediaProgressesInProgress.map((mp) => mp.extraData?.libraryItemId).filter((id) => id))]
    const libraryItems = await Database.libraryItemModel.findAllExpandedWhere({ id: libraryItemsIds })

    let itemsInProgress = []

    for (const mediaProgress of mediaProgressesInProgress) {
      const oldMediaProgress = mediaProgress.getOldMediaProgress()
      const libraryItem = libraryItems.find((li) => li.id === oldMediaProgress.libraryItemId)
      if (libraryItem) {
        if (oldMediaProgress.episodeId && libraryItem.isPodcast) {
          const episode = libraryItem.media.podcastEpisodes.find((ep) => ep.id === oldMediaProgress.episodeId)
          if (episode) {
            const libraryItemWithEpisode = {
              ...libraryItem.toOldJSONMinified(),
              recentEpisode: episode.toOldJSON(libraryItem.id),
              progressLastUpdate: oldMediaProgress.lastUpdate
            }
            itemsInProgress.push(libraryItemWithEpisode)
          }
        } else if (!oldMediaProgress.episodeId) {
          itemsInProgress.push({
            ...libraryItem.toOldJSONMinified(),
            progressLastUpdate: oldMediaProgress.lastUpdate
          })
        }
      }
    }

    itemsInProgress = sort(itemsInProgress)
      .desc((li) => li.progressLastUpdate)
      .slice(0, limit)
    res.json({
      libraryItems: itemsInProgress
    })
  }

  /**
   * GET: /api/me/series/:id/remove-from-continue-listening
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async removeSeriesFromContinueListening(req, res) {
    if (!(await Database.seriesModel.checkExistsById(req.params.id))) {
      Logger.error(`[MeController] removeSeriesFromContinueListening: Series ${req.params.id} not found`)
      return res.sendStatus(404)
    }

    const hasUpdated = await req.user.addSeriesToHideFromContinueListening(req.params.id)
    if (hasUpdated) {
      SocketAuthority.clientEmitter(req.user.id, 'user_updated', req.user.toOldJSONForBrowser())
    }
    res.json(req.user.toOldJSONForBrowser())
  }

  /**
   * GET: api/me/series/:id/readd-to-continue-listening
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async readdSeriesFromContinueListening(req, res) {
    if (!(await Database.seriesModel.checkExistsById(req.params.id))) {
      Logger.error(`[MeController] readdSeriesFromContinueListening: Series ${req.params.id} not found`)
      return res.sendStatus(404)
    }

    const hasUpdated = await req.user.removeSeriesFromHideFromContinueListening(req.params.id)
    if (hasUpdated) {
      SocketAuthority.clientEmitter(req.user.id, 'user_updated', req.user.toOldJSONForBrowser())
    }
    res.json(req.user.toOldJSONForBrowser())
  }

  /**
   * GET: api/me/progress/:id/remove-from-continue-listening
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async removeItemFromContinueListening(req, res) {
    const mediaProgress = req.user.mediaProgresses.find((mp) => mp.id === req.params.id)
    if (!mediaProgress) {
      return res.sendStatus(404)
    }

    // Already hidden
    if (mediaProgress.hideFromContinueListening) {
      return res.json(req.user.toOldJSONForBrowser())
    }

    mediaProgress.hideFromContinueListening = true
    await mediaProgress.save()

    SocketAuthority.clientEmitter(req.user.id, 'user_updated', req.user.toOldJSONForBrowser())

    res.json(req.user.toOldJSONForBrowser())
  }

  /**
   * POST: /api/me/ereader-devices
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async updateUserEReaderDevices(req, res) {
    if (!req.body.ereaderDevices || !Array.isArray(req.body.ereaderDevices)) {
      return res.status(400).send('Invalid payload. ereaderDevices array required')
    }

    const userEReaderDevices = req.body.ereaderDevices
    for (const device of userEReaderDevices) {
      if (!device.name || !device.email) {
        return res.status(400).send('Invalid payload. ereaderDevices array items must have name and email')
      } else if (device.availabilityOption !== 'specificUsers' || device.users?.length !== 1 || device.users[0] !== req.user.id) {
        return res.status(400).send('Invalid payload. ereaderDevices array items must have availabilityOption "specificUsers" and only the current user')
      }
    }

    const otherDevices = Database.emailSettings.ereaderDevices.filter((device) => {
      return !Database.emailSettings.checkUserCanAccessDevice(device, req.user) || device.users?.length !== 1
    })

    const ereaderDevices = otherDevices.concat(userEReaderDevices)

    // Check for duplicate names
    const nameSet = new Set()
    const hasDupes = ereaderDevices.some((device) => {
      if (nameSet.has(device.name)) {
        return true // Duplicate found
      }
      nameSet.add(device.name)
      return false
    })

    if (hasDupes) {
      return res.status(400).send('Invalid payload. Duplicate "name" field found.')
    }

    const updated = Database.emailSettings.update({ ereaderDevices })
    if (updated) {
      await Database.updateSetting(Database.emailSettings)
      SocketAuthority.clientEmitter(req.user.id, 'ereader-devices-updated', {
        ereaderDevices: Database.emailSettings.getEReaderDevices(req.user)
      })
    }
    res.json({
      ereaderDevices: Database.emailSettings.getEReaderDevices(req.user)
    })
  }

  /**
   * GET: /api/me/stats/year/:year
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async getStatsForYear(req, res) {
    const year = Number(req.params.year)
    if (isNaN(year) || year < 2000 || year > 9999) {
      Logger.error(`[MeController] Invalid year "${year}"`)
      return res.status(400).send('Invalid year')
    }
    const data = await userStats.getStatsForYear(req.user.id, year)
    res.json(data)
  }
}
const MeController = new MeControllerClass()
module.exports = MeController
