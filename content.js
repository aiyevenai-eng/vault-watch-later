;(function () {
  const API_BASE = globalThis.VAULT_API_BASE || 'http://127.0.0.1:4321'
  const TRADING_JOURNAL_BASE = globalThis.TRADING_JOURNAL_BASE || 'http://localhost:3000'

  function extFetch(url, options = {}) {
    const nativeFetch = globalThis.fetch.bind(globalThis)
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        nativeFetch(url, options).then(resolve).catch(reject)
        return
      }
      chrome.runtime.sendMessage(
        {
          type: 'VAULT_FETCH',
          url,
          options: {
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.body,
          },
        },
        (res) => {
          if (chrome.runtime.lastError) {
            nativeFetch(url, options).then(resolve).catch(reject)
            return
          }
          resolve({
            ok: Boolean(res?.ok),
            status: res?.status || 0,
            json: async () => res?.json,
            text: async () => res?.text || '',
          })
        },
      )
    })
  }
  const WRAP_ID = 'vault-watch-later-wrap'
  const BUTTON_ID = 'vault-watch-later-button'
  const NOTES_BUTTON_ID = 'vault-learning-notes-button'
  const PICKER_ID = 'vault-watch-later-picker'
  const CHANNEL_WRAP_ID = 'vault-save-channel-wrap'
  const CHANNEL_BUTTON_ID = 'vault-save-channel-button'
  const LAST_CATEGORY_KEY = 'vaultWatchLaterLastCategory'
  const KEEPALIVE_MS = 700
  const FALLBACK_CATEGORIES = [
    'Trading',
    'AI & Tech',
    'Business',
    'Productivity',
    'English',
    'Photography',
    'Ideas',
    'Other',
  ]

  const savedIds = new Set()
  const savedCategories = new Map()
  const savedItemIds = new Map()
  let categories = [...FALLBACK_CATEGORIES]
  let lastCategory = 'Trading'
  let currentVideoId = null
  let busy = false
  let notesBusy = false
  let pickerOpen = false

  function notifyTradingJournalRefresh() {
    const bases = [TRADING_JOURNAL_BASE, 'http://localhost:3000']
    const seen = new Set()
    for (const base of bases) {
      const normalized = String(base || '').replace(/\/$/, '')
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      extFetch(`${normalized}/api/learning/watch-later/notify`, { method: 'POST', keepalive: true }).catch(() => {})
    }
  }

  let lastRenderKey = ''
  let savedIdsLoaded = false
  let keepaliveTimer = null
  let refreshTimer = null
  let mountRetryTimer = null
  let mountObserver = null
  let renderFrame = null
  let channelBusy = false
  let channelSaved = false
  let currentChannelHandle = null
  let lastChannelRenderKey = ''
  let channelMountRetryTimer = null
  const REFRESH_MS = 8000
  const MOUNT_RETRY_MS = 250
  const MOUNT_RETRY_MAX = 60

  function extractVideoId(url = location.href) {
    try {
      const parsed = new URL(url)
      if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1).split('/')[0] || null
      if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/')[2] || null
      return parsed.searchParams.get('v')
    } catch {
      return null
    }
  }

  function pageLooksLikeWatchPage() {
    return Boolean(extractVideoId()) && (location.pathname === '/watch' || location.pathname.startsWith('/shorts/'))
  }

  function pageLooksLikeChannelPage() {
    if (pageLooksLikeWatchPage()) return false
    const path = location.pathname || ''
    if (path === '/' || path.startsWith('/feed') || path.startsWith('/results') || path.startsWith('/playlist')) {
      return false
    }
    return (
      path.startsWith('/@') ||
      path.startsWith('/channel/') ||
      path.startsWith('/c/') ||
      path.startsWith('/user/')
    )
  }

  function readTitle() {
    const h1 = document.querySelector('h1 yt-formatted-string, h1.ytd-watch-metadata yt-formatted-string')
    if (h1?.textContent?.trim()) return h1.textContent.trim()
    const meta = document.querySelector('meta[property="og:title"]')
    return meta?.content?.trim() || document.title.replace(' - YouTube', '').trim()
  }

  function readChannel() {
    const channel =
      document.querySelector('#owner #channel-name a') ||
      document.querySelector('ytd-channel-name a') ||
      document.querySelector('#upload-info ytd-channel-name a')
    return channel?.textContent?.trim() || ''
  }

  function readThumbnail(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  }

  function buildLearningImportUrl() {
    const videoId = extractVideoId()
    const params = new URLSearchParams({
      url: location.href.split('&')[0],
      title: readTitle(),
      channel: readChannel(),
      thumbnail: videoId ? readThumbnail(videoId) : '',
      source: 'MANUAL',
    })
    return `${TRADING_JOURNAL_BASE}/learning/import?${params.toString()}`
  }

  async function syncWatchLaterStatus(videoId, status) {
    try {
      await extFetch(`${API_BASE}/api/watch-later/by-youtube/${encodeURIComponent(videoId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
    } catch {
      // Best effort only.
    }
  }

  function iconMarkup(saved) {
    if (saved) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>'
    }
    return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 8.5v7l6-3.5-6-3.5z"/></svg>'
  }

  function notesIconMarkup() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>'
  }

  function chevronMarkup() {
    return '<svg class="vault-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>'
  }

  function mountHasActionButtons(mount) {
    return Boolean(
      mount.querySelector(
        'button[aria-label*="Share"], button[aria-label*="分享"], button[aria-label*="Save"], button[aria-label*="保存"], button[aria-label*="like"], button[aria-label*="赞"]',
      ),
    )
  }

  function isUsableMount(mount) {
    return Boolean(mount?.isConnected && mount.children.length > 0 && mount.getClientRects().length > 0)
  }

  function collectMountCandidates() {
    const seen = new Set()
    const mounts = []
    const selectors = [
      'ytd-watch-metadata #top-level-buttons-computed',
      'ytd-watch-metadata #actions #top-level-buttons-computed',
      '#above-the-fold #top-level-buttons-computed',
      '#top-level-buttons-computed',
    ]
    for (const selector of selectors) {
      for (const mount of document.querySelectorAll(selector)) {
        if (seen.has(mount)) continue
        seen.add(mount)
        mounts.push(mount)
      }
    }
    return mounts
  }

  function findMountPoint() {
    const candidates = collectMountCandidates()
    for (const mount of candidates) {
      if (isUsableMount(mount) && mount.closest('ytd-watch-metadata')) return mount
    }
    for (const mount of candidates) {
      if (isUsableMount(mount) && mountHasActionButtons(mount)) return mount
    }
    for (const mount of candidates) {
      if (mount.isConnected && mount.closest('ytd-watch-metadata') && mount.children.length > 0) return mount
    }
    return null
  }

  function findSaveHost(mount) {
    const saveBtn = mount.querySelector(
      'button[aria-label="Save to playlist"], button[aria-label*="Save to playlist"], button[aria-label="Save"], button[aria-label*="Save"], button[aria-label="保存"], button[aria-label*="保存"]',
    )
    if (!saveBtn) return null
    let node = saveBtn
    while (node.parentElement && node.parentElement !== mount) {
      node = node.parentElement
    }
    return node.parentElement === mount ? node : null
  }

  function removeOurButtonOnly() {
    closePicker()
    document.getElementById(WRAP_ID)?.remove()
    lastRenderKey = ''
  }

  function insertOurButton(mount, wrap) {
    const saveHost = findSaveHost(mount)
    if (saveHost) {
      mount.insertBefore(wrap, saveHost)
    } else {
      mount.appendChild(wrap)
    }
  }

  function loadLastCategory() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get([LAST_CATEGORY_KEY], (result) => {
          const value = result?.[LAST_CATEGORY_KEY]
          if (typeof value === 'string' && value.trim()) lastCategory = value.trim()
        })
        return
      }
    } catch {
      // fall through
    }
    try {
      const value = localStorage.getItem(LAST_CATEGORY_KEY)
      if (value?.trim()) lastCategory = value.trim()
    } catch {
      // ignore
    }
  }

  function persistLastCategory(category) {
    lastCategory = category
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({ [LAST_CATEGORY_KEY]: category })
        return
      }
    } catch {
      // fall through
    }
    try {
      localStorage.setItem(LAST_CATEGORY_KEY, category)
    } catch {
      // ignore
    }
  }

  async function loadCategories() {
    try {
      const res = await extFetch(`${API_BASE}/api/watch-later/settings`)
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data.categories) && data.categories.length > 0) {
        categories = data.categories.map((entry) => String(entry).trim()).filter(Boolean)
      }
    } catch {
      // keep fallback
    }
  }

  async function loadSavedIds() {
    try {
      const res = await extFetch(`${API_BASE}/api/watch-later`)
      if (!res.ok) return
      const data = await res.json()
      savedIds.clear()
      savedCategories.clear()
      savedItemIds.clear()
      for (const item of data.items || []) {
        if (!item.youtubeId) continue
        savedIds.add(item.youtubeId)
        if (item.id) savedItemIds.set(item.youtubeId, item.id)
        if (item.category) savedCategories.set(item.youtubeId, item.category)
      }
      savedIdsLoaded = true
    } catch {
      // offline ok
    }
  }

  function closePicker() {
    pickerOpen = false
    document.getElementById(PICKER_ID)?.remove()
  }

  function openPicker(anchor) {
    closePicker()
    pickerOpen = true

    const picker = document.createElement('div')
    picker.id = PICKER_ID
    picker.className = 'vault-category-picker'
    picker.innerHTML = `
      <div class="vault-category-picker-title">Save to Vault</div>
      <div class="vault-category-picker-hint">Choose a category</div>
      <div class="vault-category-picker-list"></div>
    `

    const list = picker.querySelector('.vault-category-picker-list')
    const ordered = [...categories]
    if (lastCategory && !ordered.includes(lastCategory)) ordered.unshift(lastCategory)

    for (const category of ordered) {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = 'vault-category-option'
      if (category === lastCategory) option.classList.add('is-preferred')
      option.textContent = category
      if (category === lastCategory) {
        const badge = document.createElement('span')
        badge.className = 'vault-category-preferred'
        badge.textContent = 'Last used'
        option.appendChild(badge)
      }
      option.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        closePicker()
        saveWithCategory(category)
      })
      list.appendChild(option)
    }

    const rect = anchor.getBoundingClientRect()
    picker.style.top = `${Math.round(rect.bottom + 8)}px`
    picker.style.left = `${Math.round(rect.left)}px`
    document.body.appendChild(picker)

    // Keep inside viewport.
    requestAnimationFrame(() => {
      const box = picker.getBoundingClientRect()
      if (box.right > window.innerWidth - 12) {
        picker.style.left = `${Math.max(12, window.innerWidth - box.width - 12)}px`
      }
      if (box.bottom > window.innerHeight - 12) {
        picker.style.top = `${Math.max(12, rect.top - box.height - 8)}px`
      }
    })
  }

  function ensureWrap(mount) {
    let wrap = document.getElementById(WRAP_ID)
    if (wrap) {
      if (wrap.parentElement !== mount) {
        insertOurButton(mount, wrap)
        lastRenderKey = ''
      }
      return wrap
    }

    wrap = document.createElement('div')
    wrap.id = WRAP_ID
    wrap.className = 'style-scope ytd-menu-renderer vault-action-wrap'

    const watchButton = document.createElement('button')
    watchButton.id = BUTTON_ID
    watchButton.type = 'button'
    watchButton.className = 'vault-watch-later-btn'
    watchButton.addEventListener('click', onWatchLaterClick)
    wrap.appendChild(watchButton)

    const notesButton = document.createElement('button')
    notesButton.id = NOTES_BUTTON_ID
    notesButton.type = 'button'
    notesButton.className = 'vault-learning-notes-btn'
    notesButton.addEventListener('click', onNotesClick)
    wrap.appendChild(notesButton)

    insertOurButton(mount, wrap)
    lastRenderKey = ''
    return wrap
  }

  function stopMountRetry() {
    if (!mountRetryTimer) return
    clearInterval(mountRetryTimer)
    mountRetryTimer = null
  }

  function startMountRetry() {
    if (mountRetryTimer || !pageLooksLikeWatchPage()) return
    let attempts = 0
    mountRetryTimer = setInterval(() => {
      attempts += 1
      if (!pageLooksLikeWatchPage()) {
        stopMountRetry()
        return
      }
      renderButton()
      const mount = findMountPoint()
      const wrap = document.getElementById(WRAP_ID)
      // YouTube often rebuilds the action bar after the first paint, so keep
      // retrying briefly even after a successful mount.
      if (mount && wrap?.isConnected && wrap.parentElement === mount && attempts >= 8) {
        stopMountRetry()
        return
      }
      if (attempts >= MOUNT_RETRY_MAX) stopMountRetry()
    }, MOUNT_RETRY_MS)
  }

  function renderButton() {
    const videoId = extractVideoId()
    if (!pageLooksLikeWatchPage() || !videoId) {
      stopMountRetry()
      removeOurButtonOnly()
      currentVideoId = null
      return
    }

    const mount = findMountPoint()
    if (!mount) {
      startMountRetry()
      return
    }

    ensureWrap(mount)

    const saved = savedIds.has(videoId)
    const category = savedCategories.get(videoId) || ''
    const label = saved ? (category ? `Saved · ${category}` : 'Saved') : 'Watch Later'
    const renderKey = `${videoId}|${saved}|${category}|${busy}|${notesBusy}|${label}|${pickerOpen}`

    const wrap = document.getElementById(WRAP_ID)
    if (wrap) {
      const correctMount = findMountPoint()
      if (correctMount && wrap.parentElement !== correctMount) {
        insertOurButton(correctMount, wrap)
        lastRenderKey = ''
      } else if (correctMount) {
        const saveHost = findSaveHost(correctMount)
        if (
          saveHost &&
          wrap.nextElementSibling !== saveHost &&
          wrap.compareDocumentPosition(saveHost) & Node.DOCUMENT_POSITION_FOLLOWING
        ) {
          insertOurButton(correctMount, wrap)
          lastRenderKey = ''
        }
      }
    }

    const button = document.getElementById(BUTTON_ID)
    const notesButton = document.getElementById(NOTES_BUTTON_ID)
    if (!button || !notesButton) return
    if (renderKey === lastRenderKey) return
    lastRenderKey = renderKey

    button.classList.toggle('is-saved', saved)
    button.classList.toggle('is-busy', busy)
    button.innerHTML = saved
      ? `${iconMarkup(true)}<span>${label}</span>`
      : `${iconMarkup(false)}<span>${label}</span>${chevronMarkup()}`
    button.title = saved
      ? category
        ? `In Vault · ${category} — click to remove`
        : 'In Vault — click to remove'
      : 'Choose a category and save to Vault Watch Later'

    notesButton.classList.toggle('is-busy', notesBusy)
    notesButton.innerHTML = `${notesIconMarkup()}<span>写笔记</span>`
    notesButton.title = 'Open Trading Journal notes for this video'

    currentVideoId = videoId
  }

  async function pinItemToTop(itemId) {
    if (!itemId) return
    const listRes = await extFetch(`${API_BASE}/api/watch-later`)
    if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`)
    const data = await listRes.json()
    const ids = (data.items || []).map((item) => item.id).filter(Boolean)
    const nextOrder = [itemId, ...ids.filter((id) => id !== itemId)]
    const reorderRes = await extFetch(`${API_BASE}/api/watch-later/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: nextOrder }),
    })
    if (!reorderRes.ok) throw new Error(`HTTP ${reorderRes.status}`)
  }

  async function saveWithCategory(category) {
    const videoId = extractVideoId()
    if (!videoId || busy || savedIds.has(videoId)) return

    persistLastCategory(category)
    busy = true
    lastRenderKey = ''
    // Optimistic: show saved state immediately with chosen category.
    savedIds.add(videoId)
    savedCategories.set(videoId, category)
    renderButton()

    try {
      const res = await extFetch(`${API_BASE}/api/watch-later`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          youtubeId: videoId,
          title: readTitle(),
          channel: readChannel(),
          thumbnail: readThumbnail(videoId),
          url: location.href.split('&')[0],
          category,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json().catch(() => null)
      let item = data?.item || null
      let itemId = item?.id || null

      // Production may still ignore category on POST — force it with PATCH.
      if (itemId && String(item?.category || '').trim() !== category) {
        const patchRes = await extFetch(`${API_BASE}/api/watch-later/${encodeURIComponent(itemId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category }),
        })
        if (patchRes.ok) {
          const patched = await patchRes.json().catch(() => null)
          if (patched?.item) item = patched.item
        }
      }

      // Always pin newly saved video to the top, even if the server still appends to bottom.
      if (itemId) {
        await pinItemToTop(itemId)
      }

      const savedCategory = item?.category || category
      savedCategories.set(videoId, savedCategory)
      if (itemId) savedItemIds.set(videoId, itemId)
      notifyTradingJournalRefresh()
    } catch (err) {
      console.error('[Vault Watch Later]', err)
      savedIds.delete(videoId)
      savedCategories.delete(videoId)
      savedItemIds.delete(videoId)
      alert('Could not save to Vault. Check your internet connection and try again.')
    } finally {
      busy = false
      lastRenderKey = ''
      renderButton()
    }
  }

  async function refreshSavedState() {
    await Promise.all([loadSavedIds(), loadCategories()])
    renderButton()
  }

  async function unsaveVideo(videoId) {
    if (!videoId || busy || !savedIds.has(videoId)) return

    const previousCategory = savedCategories.get(videoId)
    const previousItemId = savedItemIds.get(videoId)

    busy = true
    lastRenderKey = ''
    savedIds.delete(videoId)
    savedCategories.delete(videoId)
    savedItemIds.delete(videoId)
    closePicker()
    renderButton()

    try {
      let res = await extFetch(`${API_BASE}/api/watch-later/by-youtube/${encodeURIComponent(videoId)}`, {
        method: 'DELETE',
      })
      if (res.status === 404) {
        notifyTradingJournalRefresh()
      } else if (!res.ok) {
        let itemId = previousItemId
        if (!itemId) {
          const listRes = await extFetch(`${API_BASE}/api/watch-later`)
          if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`)
          const data = await listRes.json()
          itemId = (data.items || []).find((item) => item.youtubeId === videoId)?.id
        }
        if (!itemId) {
          notifyTradingJournalRefresh()
        } else {
          res = await extFetch(`${API_BASE}/api/watch-later/${encodeURIComponent(itemId)}`, { method: 'DELETE' })
          if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
          notifyTradingJournalRefresh()
        }
      } else {
        notifyTradingJournalRefresh()
      }
    } catch (err) {
      console.error('[Vault Watch Later]', err)
      savedIds.add(videoId)
      if (previousCategory) savedCategories.set(videoId, previousCategory)
      if (previousItemId) savedItemIds.set(videoId, previousItemId)
      alert('Could not remove from Vault. Check your internet connection and try again.')
    } finally {
      busy = false
      lastRenderKey = ''
      renderButton()
    }
  }

  function onWatchLaterClick(e) {
    e.preventDefault()
    e.stopPropagation()

    const videoId = extractVideoId()
    if (!videoId || busy) return

    // Toggle: already saved → remove from Vault.
    if (savedIds.has(videoId)) {
      unsaveVideo(videoId)
      return
    }

    if (pickerOpen) {
      closePicker()
      return
    }

    openPicker(e.currentTarget)
    lastRenderKey = ''
    renderButton()
  }

  async function onNotesClick(e) {
    e.preventDefault()
    e.stopPropagation()
    closePicker()

    const videoId = extractVideoId()
    if (!videoId || notesBusy) return

    notesBusy = true
    lastRenderKey = ''
    renderButton()

    try {
      window.open(buildLearningImportUrl(), '_blank', 'noopener,noreferrer')
      syncWatchLaterStatus(videoId, 'watching')
    } finally {
      notesBusy = false
      lastRenderKey = ''
      renderButton()
    }
  }

  function channelIconMarkup(saved) {
    return saved
      ? `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`
  }

  function normalizeHandle(raw) {
    return String(raw || '')
      .trim()
      .replace(/^@+/, '')
      .toLowerCase()
  }

  function readChannelPageMeta() {
    const path = location.pathname || ''
    let handle = ''
    let channelId = null

    const atMatch = path.match(/^\/@([^/?#]+)/)
    if (atMatch) handle = decodeURIComponent(atMatch[1])

    const channelMatch = path.match(/^\/channel\/(UC[\w-]+)/)
    if (channelMatch) channelId = channelMatch[1]

    if (!handle) {
      const handleEl =
        document.querySelector('#page-header yt-content-metadata-view-model span') ||
        document.querySelector('yt-content-metadata-view-model span') ||
        document.querySelector('#channel-handle') ||
        document.querySelector('meta[property="og:url"]')
      const text =
        handleEl?.textContent?.trim() ||
        handleEl?.content ||
        ''
      const fromText = text.match(/@([\w.-]+)/)
      if (fromText) handle = fromText[1]
      else if (channelId) handle = channelId.toLowerCase()
    }

    const name =
      document.querySelector('#page-header h1, #page-header yt-dynamic-text-view-model')?.textContent?.trim() ||
      document.querySelector('ytd-channel-name #text')?.textContent?.trim() ||
      document.querySelector('meta[property="og:title"]')?.content?.replace(/\s*-\s*YouTube\s*$/i, '').trim() ||
      handle ||
      'YouTuber'

    const avatar =
      document.querySelector('#page-header img')?.src ||
      document.querySelector('#channel-header-container img')?.src ||
      document.querySelector('yt-page-header-view-model img')?.src ||
      document.querySelector('meta[property="og:image"]')?.content ||
      ''

    const channelUrl = handle
      ? `https://www.youtube.com/@${normalizeHandle(handle)}`
      : channelId
        ? `https://www.youtube.com/channel/${channelId}`
        : location.href.split('?')[0]

    return {
      handle: normalizeHandle(handle),
      name,
      avatarUrl: avatar,
      channelUrl,
      channelId,
    }
  }

  function findChannelMountPoint() {
    const selectors = [
      '#page-header #buttons',
      '#page-header yt-flexible-actions-view-model',
      'yt-page-header-view-model yt-flexible-actions-view-model',
      '#inner-header-container #buttons',
      '#channel-header #buttons',
      'ytd-c4-tabbed-header-renderer #buttons',
    ]
    for (const selector of selectors) {
      const el = document.querySelector(selector)
      if (el?.isConnected) return el
    }
    return null
  }

  function removeChannelButton() {
    document.getElementById(CHANNEL_WRAP_ID)?.remove()
    lastChannelRenderKey = ''
  }

  function stopChannelMountRetry() {
    if (!channelMountRetryTimer) return
    clearInterval(channelMountRetryTimer)
    channelMountRetryTimer = null
  }

  function startChannelMountRetry() {
    if (channelMountRetryTimer || !pageLooksLikeChannelPage()) return
    let attempts = 0
    channelMountRetryTimer = setInterval(() => {
      attempts += 1
      if (!pageLooksLikeChannelPage()) {
        stopChannelMountRetry()
        return
      }
      renderChannelButton()
      const mount = findChannelMountPoint()
      const wrap = document.getElementById(CHANNEL_WRAP_ID)
      if (mount && wrap?.isConnected && wrap.parentElement === mount && attempts >= 8) {
        stopChannelMountRetry()
        return
      }
      if (attempts >= MOUNT_RETRY_MAX) stopChannelMountRetry()
    }, MOUNT_RETRY_MS)
  }

  function ensureChannelWrap(mount) {
    let wrap = document.getElementById(CHANNEL_WRAP_ID)
    if (wrap) {
      if (wrap.parentElement !== mount) mount.appendChild(wrap)
      return wrap
    }
    wrap = document.createElement('div')
    wrap.id = CHANNEL_WRAP_ID
    wrap.className = 'vault-action-wrap vault-channel-wrap'

    const button = document.createElement('button')
    button.id = CHANNEL_BUTTON_ID
    button.type = 'button'
    button.className = 'vault-save-channel-btn'
    button.addEventListener('click', onSaveChannelClick)
    wrap.appendChild(button)
    mount.appendChild(wrap)
    lastChannelRenderKey = ''
    return wrap
  }

  async function refreshChannelSavedState(handle) {
    if (!handle) {
      channelSaved = false
      return
    }
    try {
      const res = await extFetch(
        `${TRADING_JOURNAL_BASE}/api/learning/youtubers/by-handle/${encodeURIComponent(handle)}`,
        { cache: 'no-store' },
      )
      if (!res.ok) return
      const data = await res.json()
      channelSaved = Boolean(data.saved)
    } catch {
      // ignore — button still works for saving
    }
  }

  function notifyYoutuberRefresh() {
    const bases = [TRADING_JOURNAL_BASE, 'http://localhost:3000']
    const seen = new Set()
    for (const base of bases) {
      const normalized = String(base || '').replace(/\/$/, '')
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      extFetch(`${normalized}/api/learning/youtubers/notify`, { method: 'POST', keepalive: true }).catch(() => {})
    }
  }

  function renderChannelButton() {
    if (!pageLooksLikeChannelPage()) {
      stopChannelMountRetry()
      removeChannelButton()
      currentChannelHandle = null
      return
    }

    const meta = readChannelPageMeta()
    if (!meta.handle) {
      startChannelMountRetry()
      return
    }

    const mount = findChannelMountPoint()
    if (!mount) {
      startChannelMountRetry()
      return
    }

    ensureChannelWrap(mount)

    if (meta.handle !== currentChannelHandle) {
      currentChannelHandle = meta.handle
      channelSaved = false
      lastChannelRenderKey = ''
      void refreshChannelSavedState(meta.handle).then(() => {
        lastChannelRenderKey = ''
        renderChannelButton()
      })
    }

    const button = document.getElementById(CHANNEL_BUTTON_ID)
    if (!button) return

    const label = channelSaved ? '已收藏' : '收藏频道'
    const renderKey = `${meta.handle}|${channelSaved}|${channelBusy}|${label}`
    if (renderKey === lastChannelRenderKey) return
    lastChannelRenderKey = renderKey

    button.classList.toggle('is-saved', channelSaved)
    button.classList.toggle('is-busy', channelBusy)
    button.innerHTML = `${channelIconMarkup(channelSaved)}<span>${label}</span>`
    button.title = channelSaved
      ? '已收藏到 Trading Journal · 收藏频道'
      : '收藏此 YouTuber 到 Trading Journal'
  }

  async function onSaveChannelClick(e) {
    e.preventDefault()
    e.stopPropagation()
    if (channelBusy || channelSaved) return

    const meta = readChannelPageMeta()
    if (!meta.handle) return

    channelBusy = true
    lastChannelRenderKey = ''
    renderChannelButton()

    try {
      const res = await extFetch(`${TRADING_JOURNAL_BASE}/api/learning/youtubers/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle: meta.handle,
          name: meta.name,
          avatarUrl: meta.avatarUrl,
          channelUrl: meta.channelUrl,
          channelId: meta.channelId,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      channelSaved = true
      notifyYoutuberRefresh()
    } catch (error) {
      console.warn('[vault] save channel failed', error)
    } finally {
      channelBusy = false
      lastChannelRenderKey = ''
      renderChannelButton()
    }
  }

  function onNavigate() {
    closePicker()

    if (pageLooksLikeChannelPage()) {
      stopMountRetry()
      removeOurButtonOnly()
      currentVideoId = null
      renderChannelButton()
      startChannelMountRetry()
      return
    }

    stopChannelMountRetry()
    removeChannelButton()
    currentChannelHandle = null

    const videoId = extractVideoId()

    // Left the watch page — tear down controls.
    if (!pageLooksLikeWatchPage() || !videoId) {
      stopMountRetry()
      removeOurButtonOnly()
      currentVideoId = null
      return
    }

    // Keep the existing wrap when possible; only reset render state on video change.
    // Never wait on the API before mounting — YouTube SPA often rebuilds the action
    // bar after navigation, and a delayed first paint is what made the buttons vanish.
    if (videoId !== currentVideoId) {
      currentVideoId = videoId
      lastRenderKey = ''
      const wrap = document.getElementById(WRAP_ID)
      if (wrap && !wrap.isConnected) removeOurButtonOnly()
    }

    renderButton()
    startMountRetry()
    void refreshSavedState()
  }

  function onDocumentClick(event) {
    if (!pickerOpen) return
    const picker = document.getElementById(PICKER_ID)
    const button = document.getElementById(BUTTON_ID)
    if (picker?.contains(event.target) || button?.contains(event.target)) return
    closePicker()
  }

  function startKeepalive() {
    if (keepaliveTimer) return
    keepaliveTimer = setInterval(() => {
      if (pageLooksLikeChannelPage()) {
        renderChannelButton()
        return
      }
      if (!pageLooksLikeWatchPage()) return
      renderButton()
    }, KEEPALIVE_MS)
  }

  function scheduleRender() {
    if (renderFrame) return
    if (pageLooksLikeChannelPage()) {
      renderFrame = requestAnimationFrame(() => {
        renderFrame = null
        renderChannelButton()
      })
      return
    }
    if (!pageLooksLikeWatchPage()) return
    renderFrame = requestAnimationFrame(() => {
      renderFrame = null
      renderButton()
    })
  }

  function startMountObserver() {
    if (mountObserver) return
    mountObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue
        if (pageLooksLikeChannelPage()) {
          const wrap = document.getElementById(CHANNEL_WRAP_ID)
          if (!wrap || !wrap.isConnected || mutation.target.closest?.('#page-header, yt-page-header-view-model, #channel-header')) {
            scheduleRender()
            startChannelMountRetry()
            return
          }
          continue
        }
        const wrap = document.getElementById(WRAP_ID)
        if (!wrap || !wrap.isConnected || mutation.target.closest?.('ytd-watch-metadata, #above-the-fold, #actions')) {
          scheduleRender()
          startMountRetry()
          return
        }
      }
    })
    mountObserver.observe(document.documentElement, { childList: true, subtree: true })
  }

  function startRefreshLoop() {
    if (refreshTimer) return
    refreshTimer = setInterval(() => {
      if (pageLooksLikeChannelPage()) {
        if (!channelBusy && currentChannelHandle) {
          void refreshChannelSavedState(currentChannelHandle).then(() => {
            lastChannelRenderKey = ''
            renderChannelButton()
          })
        }
        return
      }
      if (!pageLooksLikeWatchPage() || busy) return
      void loadSavedIds().then(renderButton)
    }, REFRESH_MS)
  }

  function patchHistory(method) {
    const original = history[method]
    history[method] = function patchedHistory(...args) {
      const result = original.apply(this, args)
      onNavigate()
      return result
    }
  }

  loadLastCategory()
  patchHistory('pushState')
  patchHistory('replaceState')
  window.addEventListener('popstate', onNavigate)
  window.addEventListener('yt-navigate-finish', onNavigate)
  window.addEventListener('yt-navigate-start', onNavigate)
  window.addEventListener('yt-page-data-updated', onNavigate)
  document.addEventListener('yt-navigate-finish', onNavigate)
  document.addEventListener('yt-page-data-updated', onNavigate)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (pageLooksLikeChannelPage()) {
        renderChannelButton()
        startChannelMountRetry()
        if (currentChannelHandle) void refreshChannelSavedState(currentChannelHandle)
        return
      }
      renderButton()
      startMountRetry()
      void refreshSavedState()
    }
  })
  document.addEventListener('click', onDocumentClick, true)

  // Render controls immediately. Their visibility must never depend on the
  // local API being online or responding quickly.
  onNavigate()
  startKeepalive()
  startMountObserver()
  startRefreshLoop()

  Promise.all([loadSavedIds(), loadCategories()]).finally(() => {
    lastRenderKey = ''
    renderButton()
    startMountRetry()
  })
})()
