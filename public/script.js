const $ = (s) => document.querySelector(s),
  $$ = (s) => document.querySelectorAll(s);
let songs = [],
  categories = [],
  managedUploads = [],
  user = null,
  recommendationIds = [],
  activeCategory = null,
  queue = [],
  currentId = null,
  nextUpIds = [],
  queueScope = "all";
let shuffleOn = false;
let signupMode = false;
let guestPreviewActive = false;
let categoryDiscoveryIds = [];
let homeCategoryFilter = "all";
let hiddenDefaultRows = new Set();
let managerAccountFilter = null;
let adminBoostMode = null;
let banAccountTarget = null;
let managerCategoryPriority = null;
let pendingUploads = [];
let pendingUploadsLoading = false;
let pendingPreviewId = null;
const SONG_PAGE_SIZE = 20;
let songPage = 0;
let songsHaveMore = false;
let songsPageLoading = false;
const pendingDurationCache = new Map();
try {
  const savedRows = JSON.parse(
    localStorage.getItem("d50_hidden_default_rows") || "[]",
  );
  hiddenDefaultRows = new Set(Array.isArray(savedRows) ? savedRows : []);
} catch {
  hiddenDefaultRows = new Set();
}
let sessionToken = localStorage.getItem("d50_session") || "";
const savedGuestListens = Number(
  localStorage.getItem("d50_guest_listens") || 0,
);
let guestListenCount = Number.isFinite(savedGuestListens)
  ? Math.max(0, Math.floor(savedGuestListens))
  : 0;
function cleanText(value, maximumLength) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>&"'`]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}
function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (sessionToken) headers.set("Authorization", `Bearer ${sessionToken}`);
  return fetch(url, { ...options, headers });
}
const sidebar = $("aside");
const sidebarCollapsed =
  localStorage.getItem("d50_sidebar_collapsed") === "true";
function setSidebar(collapsed) {
  sidebar.classList.toggle("collapsed", collapsed);
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  $("#sidebarToggle").setAttribute("aria-expanded", String(!collapsed));
  $("#sidebarToggle").setAttribute(
    "aria-label",
    collapsed ? "Expand sidebar" : "Collapse sidebar",
  );
  $("#sidebarToggle").title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  localStorage.setItem("d50_sidebar_collapsed", String(collapsed));
}
setSidebar(sidebarCollapsed);
$("#sidebarToggle").onclick = () =>
  setSidebar(!sidebar.classList.contains("collapsed"));
let queueCompact = localStorage.getItem("d50_queue_compact") === "true";
function setQueueCompact(compact) {
  queueCompact = Boolean(compact);
  $("#nextUpPanel").classList.toggle("compact", queueCompact);
  document.body.classList.toggle("queue-compact", queueCompact);
  const button = $("#queueLayoutToggle");
  button.setAttribute("aria-pressed", String(queueCompact));
  button.setAttribute(
    "aria-label",
    queueCompact ? "Show queue names" : "Show artwork-only queue",
  );
  button.title = queueCompact
    ? "Show queue names"
    : "Show artwork-only queue";
  localStorage.setItem("d50_queue_compact", String(queueCompact));
}
setQueueCompact(queueCompact);
$("#queueLayoutToggle").onclick = () => setQueueCompact(!queueCompact);
const mobileQueueToggle = $("#mobileQueueToggle");
const queueDrawerClose = $("#queueDrawerClose");
const queueDrawerBackdrop = $("#queueDrawerBackdrop");

function setMobileQueueOpen(open, restoreFocus = false) {
  const isOpen = Boolean(open);
  document.body.classList.toggle("mobile-queue-open", isOpen);
  $("#nextUpPanel").classList.toggle("mobile-open", isOpen);
  mobileQueueToggle.setAttribute("aria-expanded", String(isOpen));
  mobileQueueToggle.setAttribute(
    "aria-label",
    isOpen ? "Close Next Up queue" : "Open Next Up queue",
  );
  if (isOpen) queueDrawerClose.focus();
  else if (restoreFocus) mobileQueueToggle.focus();
}

mobileQueueToggle.onclick = () =>
  setMobileQueueOpen(!$("#nextUpPanel").classList.contains("mobile-open"));
queueDrawerClose.onclick = () => setMobileQueueOpen(false, true);
queueDrawerBackdrop.onclick = () => setMobileQueueOpen(false, true);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#nextUpPanel").classList.contains("mobile-open"))
    setMobileQueueOpen(false, true);
});
window.addEventListener("resize", () => {
  if (window.innerWidth >= 768) setMobileQueueOpen(false);
});
const audio = $("#audio"),
  fmt = (n) =>
    Number.isFinite(n)
      ? Math.floor(n / 60) + ":" + String(Math.floor(n % 60)).padStart(2, "0")
      : "0:00";
function view(id) {
  if (id === "upload" && !user) return showAuth(true);
  $$("main > section").forEach((x) => (x.hidden = x.id !== id));
  if (id === "upload") maybeShowUploadWarning();
}
$$("[data-v]").forEach((b) => (b.onclick = () => view(b.dataset.v)));
const active = () => songs.find((song) => song.id === currentId);
const queueSongById = (id) =>
  songs.find((song) => song.id === id) ||
  managedUploads.find((song) => song.id === id);
function queueSongs() {
  return queue
    .map((id) => songs.find((song) => song.id === id))
    .filter(
      (song) => song && (queueScope !== "songs" || Boolean(song.liked)),
    );
}
function orderedUpcomingCandidates() {
  const scoped = queueSongs();
  const currentIndex = scoped.findIndex((song) => song.id === currentId);
  const rotated = currentIndex < 0
    ? scoped
    : [...scoped.slice(currentIndex + 1), ...scoped.slice(0, currentIndex)];
  const combined = [...rotated, ...songs];
  const seen = new Set();
  return combined.filter((song) => {
    if (!song || song.id === currentId || seen.has(song.id)) return false;
    seen.add(song.id);
    return true;
  });
}
function fillNextUp(preservedIds = [], excludedIds = []) {
  if (!currentId) {
    nextUpIds = [];
    renderNextUp();
    return;
  }
  const excluded = new Set(excludedIds);
  const validIds = new Set(songs.map((song) => song.id));
  const next = preservedIds.filter(
    (id) => id !== currentId && !excluded.has(id) && validIds.has(id),
  );
  let candidates = orderedUpcomingCandidates().filter(
    (song) => !excluded.has(song.id) && !next.includes(song.id),
  );
  if (shuffleOn) {
    for (let index = candidates.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [candidates[index], candidates[randomIndex]] = [
        candidates[randomIndex],
        candidates[index],
      ];
    }
  }
  while (next.length < 4 && candidates.length) {
    next.push(candidates.shift().id);
  }
  const repeatPool = orderedUpcomingCandidates().filter(
    (song) => !excluded.has(song.id),
  );
  let repeatIndex = 0;
  while (next.length < 4 && repeatPool.length) {
    next.push(repeatPool[repeatIndex % repeatPool.length].id);
    repeatIndex += 1;
  }
  nextUpIds = next.slice(0, 4);
  renderNextUp();
}
function removeUpcomingAt(index) {
  const removedId = nextUpIds[index];
  if (!removedId) return;
  const remaining = nextUpIds.filter((_, itemIndex) => itemIndex !== index);
  fillNextUp(remaining, [removedId]);
}
function injectIntoQueueSlot(song, slotIndex) {
  if (!song || slotIndex < 0 || slotIndex > 3) return;
  const updated = nextUpIds.slice(0, 4);
  updated[slotIndex] = song.id;
  nextUpIds = updated;
  renderNextUp();
}
function createQueueInjector(song) {
  const injector = document.createElement("div");
  injector.className = "queue-injector";
  injector.setAttribute("aria-label", `Choose a queue slot for ${song.title}`);
  const label = document.createElement("span");
  label.textContent = "QUEUE";
  injector.append(label);
  for (let index = 0; index < 4; index += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(index + 1);
    button.title = `Put ${song.title} in LIVE QUEUE slot ${index + 1}`;
    button.setAttribute("aria-label", button.title);
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      injectIntoQueueSlot(song, index);
    };
    injector.append(button);
  }
  injector.onclick = (event) => event.stopPropagation();
  return injector;
}
function renderNextUp() {
  const slot = $("#nextUpSlot");
  if (!slot) return;
  slot.innerHTML = "";
  const upcomingSlots = nextUpIds
    .slice(0, 4)
    .map((id, index) => ({
      index,
      upcoming: queueSongById(id),
    }))
    .filter((slotItem) => Boolean(slotItem.upcoming));
  if (!upcomingSlots.length) {
    const empty = document.createElement("div");
    empty.className = "next-up-empty";
    empty.innerHTML =
      '<span aria-hidden="true">♫</span><b>Nothing queued yet</b><small>Play a song to build the four-track queue.</small>';
    slot.append(empty);
    return;
  }
  upcomingSlots.forEach(({ upcoming, index }) => {
    const card = document.createElement("article");
    card.className = "next-up-card";
    card.style.setProperty("--queue-index", index);
    card.dataset.songId = upcoming.id;
    const cover = document.createElement("div");
    cover.className = "next-up-cover";
    cover.textContent = "◎";
    if (upcoming.coverUrl) {
      cover.textContent = "";
      cover.style.backgroundImage = `url("${upcoming.coverUrl}")`;
    }
    const copy = document.createElement("div");
    copy.className = "next-up-copy";
    const label = document.createElement("small");
    label.textContent = `${index + 1} · UP NEXT`;
    const title = document.createElement("b");
    title.textContent = upcoming.title;
    const source = document.createElement("span");
    source.textContent = "D50 local catalog";
    copy.append(label, title, source);
    const dismiss = document.createElement("button");
    dismiss.className = "next-up-dismiss";
    dismiss.type = "button";
    dismiss.textContent = "×";
    dismiss.title = `Remove ${upcoming.title} from queue position ${index + 1}`;
    dismiss.setAttribute("aria-label", dismiss.title);
    dismiss.onclick = () => removeUpcomingAt(index);
    card.append(cover, copy, dismiss);
    slot.append(card);
  });
}
function heart() {
  let s = active();
  $("#playerLike").textContent = s?.liked ? "♥" : "♡";
  $("#playerLike").classList.toggle("liked", !!s?.liked);
  $("#playerLike").disabled = !canLikeSongs();
  $("#playerLike").title = canLikeSongs()
    ? s?.liked
      ? "Unlike this song"
      : "Like this song"
    : "Premium or Admin access is required to like songs";
}
function canLikeSongs() {
  return Boolean(user?.paid || user?.adminMode);
}
function likeTitle(item, noun = "song") {
  if (!canLikeSongs())
    return `Premium or Admin access is required to like ${noun === "category" ? "categories" : "songs"}`;
  if (item?.ownerId === user?.id)
    return item.liked
      ? `Remove this ${noun} from your favorites (your own vote does not affect its public score)`
      : `Favorite your ${noun} (your own vote does not affect its public score)`;
  return item?.liked ? `Unlike this ${noun}` : `Like this ${noun}`;
}
const LIKE_DEBOUNCE_MS = 2000;
const pendingLikeUpdates = new Map();

function likeUpdateKey(type, itemId) {
  return `${type}:${itemId}`;
}

function setHeartState(button, item, noun = "song") {
  button.textContent = item.liked ? "♥" : "♡";
  button.classList.toggle("liked", Boolean(item.liked));
  button.setAttribute(
    "aria-label",
    `${item.liked ? "Unlike" : "Like"} ${noun === "category" ? item.name : item.title}`,
  );
  button.title = likeTitle(item, noun);
}

function updateSongLikeElements(song) {
  $$('[data-song-id]').forEach((element) => {
    if (element.dataset.songId !== String(song.id)) return;
    element.querySelectorAll(".heart").forEach((button) =>
      setHeartState(button, song),
    );
    element.querySelectorAll(".song-like-count").forEach(
      (counter) => (counter.textContent = Number(song.likedCount || 0)),
    );
    element.querySelectorAll(".manager-like-total").forEach((counter) => {
      const total = Number(song.likedCount || 0);
      counter.textContent = `♥ ${total} public ${total === 1 ? "like" : "likes"}`;
    });
  });
  if (currentId === song.id) heart();
}

function updateCategoryLikeElements(category) {
  $$('[data-category-id]').forEach((element) => {
    if (element.dataset.categoryId !== String(category.id)) return;
    element
      .querySelectorAll(".category-card-like, .category-pill-like")
      .forEach((button) => setHeartState(button, category, "category"));
    const rankingCount = element.querySelector(".category-ranking-open small");
    if (rankingCount) {
      const total = Number(category.likedCount || 0);
      rankingCount.textContent = `${total} ${total === 1 ? "like" : "likes"}`;
    }
    element.querySelectorAll(".manager-like-total").forEach((counter) => {
      const total = Number(category.likedCount || 0);
      counter.textContent = `♥ ${total} public ${total === 1 ? "like" : "likes"}`;
    });
  });
}

function applyOptimisticLike(state) {
  const affectsPublicCount = state.item.ownerId !== user?.id;
  state.item.liked = state.desiredLiked;
  state.item.likedCount = Math.max(
    0,
    state.confirmedCount +
      (affectsPublicCount
        ? Number(state.desiredLiked) - Number(state.confirmedLiked)
        : 0),
  );
  if (state.type === "song") updateSongLikeElements(state.item);
  else updateCategoryLikeElements(state.item);
}

async function flushLikeUpdate(key) {
  const state = pendingLikeUpdates.get(key);
  if (!state || state.inFlight) return;
  state.timer = null;
  if (state.desiredLiked === state.confirmedLiked) {
    pendingLikeUpdates.delete(key);
    return;
  }
  state.inFlight = true;
  const sentLiked = state.desiredLiked;
  const path = state.type === "song"
    ? `/api/songs/${state.item.id}/like`
    : `/api/categories/${state.item.id}/like`;
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ liked: sentLiked }),
  });
  if (!response.ok) {
    state.item.liked = state.confirmedLiked;
    state.item.likedCount = state.confirmedCount;
    state.type === "song"
      ? updateSongLikeElements(state.item)
      : updateCategoryLikeElements(state.item);
    pendingLikeUpdates.delete(key);
    return handleLocked(response);
  }
  const updated = await response.json();
  state.confirmedLiked = Boolean(updated.liked);
  state.confirmedCount = Number(updated.likedCount || 0);
  state.inFlight = false;
  if (state.desiredLiked === state.confirmedLiked) {
    state.item.liked = state.confirmedLiked;
    state.item.likedCount = state.confirmedCount;
    state.type === "song"
      ? updateSongLikeElements(state.item)
      : updateCategoryLikeElements(state.item);
    pendingLikeUpdates.delete(key);
    return;
  }
  applyOptimisticLike(state);
  const remainingDelay = Math.max(
    0,
    LIKE_DEBOUNCE_MS - (Date.now() - state.lastClickAt),
  );
  state.timer = window.setTimeout(() => flushLikeUpdate(key), remainingDelay);
}

function queueOptimisticLike(item, type) {
  const key = likeUpdateKey(type, item.id);
  let state = pendingLikeUpdates.get(key);
  if (!state) {
    state = {
      type,
      item,
      confirmedLiked: Boolean(item.liked),
      confirmedCount: Number(item.likedCount || 0),
      desiredLiked: Boolean(item.liked),
      lastClickAt: 0,
      timer: null,
      inFlight: false,
    };
    pendingLikeUpdates.set(key, state);
  }
  state.desiredLiked = !state.desiredLiked;
  state.lastClickAt = Date.now();
  if (state.timer) window.clearTimeout(state.timer);
  applyOptimisticLike(state);
  if (!state.inFlight && state.desiredLiked === state.confirmedLiked) {
    pendingLikeUpdates.delete(key);
    return;
  }
  state.timer = window.setTimeout(() => flushLikeUpdate(key), LIKE_DEBOUNCE_MS);
}

function like(song) {
  if (!user) return showAuth(true);
  if (!canLikeSongs()) return showPremium();
  queueOptimisticLike(song, "song");
}
function mediaArtworkUrl(song) {
  if (!song?.coverUrl) return "";
  try {
    return new URL(song.coverUrl, window.location.origin).href;
  } catch {
    return "";
  }
}

function updateMediaSessionMetadata(song) {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined" || !song)
    return;
  const category = categories.find((entry) =>
    (song.categoryIds || []).includes(entry.id),
  );
  const artworkUrl = mediaArtworkUrl(song);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title || "Untitled track",
    artist: song.uploaderName || song.artist || "D50 Artist",
    album: category?.name || song.album || "D50 Music",
    artwork: artworkUrl ? [{ src: artworkUrl }] : [],
  });
}

function updateMediaSessionPlaybackState() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
}

function startSongAudio(s, scope, scopeName, preservedUpcoming) {
  queue = scope.map((song) => song.id);
  queueScope = scopeName;
  currentId = s.id;
  audio.src = s.url;
  updateMediaSessionMetadata(s);
  $("#now").textContent = s.title;
  fillNextUp(Array.isArray(preservedUpcoming) ? preservedUpcoming : []);
  heart();
  updateActiveSong();

  // Keep src assignment and play() in the same synchronous execution block.
  // This is important for iOS/WebKit when advancing while the screen is locked.
  const playback = audio.play();
  if (playback?.catch)
    playback.catch((error) =>
      console.warn("Background playback could not start:", error.message),
    );
}

async function play(
  s,
  scope = songs,
  scopeName = "all",
  preservedUpcoming = null,
  options = {},
) {
  const immediateBackgroundTransition = Boolean(options.immediateBackgroundTransition);
  if (immediateBackgroundTransition)
    startSongAudio(s, scope, scopeName, preservedUpcoming);

  if (!user) {
    if (guestListenCount >= 5) return showAccountGate();
    guestListenCount += 1;
    guestPreviewActive = true;
    localStorage.setItem("d50_guest_listens", String(guestListenCount));
    updateGuestProfile();
  } else {
    const permission = await apiFetch("/api/listens/" + s.id, {
      method: "POST",
    });
    if (!permission.ok) {
      if (immediateBackgroundTransition) audio.pause();
      return handleLocked(permission);
    }
    user = await permission.json();
    guestPreviewActive = false;
    updateProfile();
  }
  if (!immediateBackgroundTransition)
    startSongAudio(s, scope, scopeName, preservedUpcoming);
}
function toggleSong(s, scope = songs, scopeName = "all") {
  if (currentId === s.id && audio.src) {
    if (!user && !guestPreviewActive) return play(s, scope, scopeName);
    if (audio.paused) audio.play();
    else audio.pause();
    return;
  }
  play(s, scope, scopeName);
}
function updateActiveSong() {
  $$("[data-song-id]").forEach((element) =>
    element.classList.toggle(
      "active-song",
      element.dataset.songId === String(currentId),
    ),
  );
  updateInlinePlayButtons();
}
function updateInlinePlayButtons() {
  const playing = !audio.paused && !audio.ended;
  $$("[data-song-id]").forEach((element) => {
    const isPlaying = element.dataset.songId === String(currentId) && playing;
    const title = element.querySelector("b");
    let equalizer = title?.querySelector(".playing-equalizer");
    if (isPlaying && title && !equalizer) {
      equalizer = document.createElement("span");
      equalizer.className = "playing-equalizer";
      equalizer.setAttribute("aria-label", "Now playing");
      equalizer.innerHTML = "<i></i><i></i><i></i>";
      title.append(equalizer);
    } else if (!isPlaying && equalizer) {
      equalizer.remove();
    }
    const rowButton = element.querySelector(".inline-play");
    const cardButton = element.querySelector(".card-play");
    const recommendationButton = element.querySelector(
      ".recommendation-play strong",
    );
    [rowButton, cardButton, recommendationButton]
      .filter(Boolean)
      .forEach((button) => {
        button.textContent = isPlaying ? "⏸" : "▶";
        button.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
      });
  });
}
function rows(el, list) {
  el.innerHTML = "";
  list.forEach((s) => {
    let r = document.createElement("div");
    r.className = "row";
    r.dataset.songId = s.id;
    r.dataset.reportId = s.id;
    r.dataset.reportName = s.title;
    r.dataset.reportType = "song";
    r.innerHTML =
      '<button class="inline-play" aria-label="Play">▶</button><i>◎</i><span><b></b><small>Stored on this PC</small></span><em>Local upload</em><select class="category-select"><option value="">No category</option></select><button class="heart">♡</button><button class="del">Delete</button>';
    appendAdminBoostHearts(r, s);
    r.querySelector("b").textContent = s.title;
    const artwork = r.querySelector("i");
    if (s.coverUrl) {
      artwork.classList.add("row-cover-art");
      artwork.textContent = "";
      artwork.style.backgroundImage = `url("${s.coverUrl}")`;
    }
    r.querySelector(".inline-play").onclick = () => toggleSong(s, list, el.id);
    let h = r.querySelector(".heart");
    h.disabled = !canLikeSongs();
    h.title = likeTitle(s);
    h.textContent = s.liked ? "♥" : "♡";
    h.classList.toggle("liked", !!s.liked);
    h.onclick = () => like(s);
    const select = r.querySelector(".category-select");
    const availableCategories = manageableCategories();
    select.hidden = !user?.canManage || !availableCategories.length;
    availableCategories.forEach((category) => {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name;
      option.selected = (s.categoryIds || []).includes(category.id);
      select.append(option);
    });
    select.onchange = () => assignSongCategory(s, select.value, select);
    select.after(createQueueInjector(s));
    const deleteButton = r.querySelector(".del");
    deleteButton.hidden = !canDeleteSong(s);
    deleteButton.textContent = "🗑";
    deleteButton.title = `Delete ${s.title}`;
    deleteButton.onclick = () => deleteSong(s);
    appendManagerAccountShortcut(r, s, "row-account-shortcut");
    if (el.id === "results") {
      r.classList.add("search-song-row");
      r.tabIndex = 0;
      r.setAttribute("role", "button");
      r.setAttribute("aria-label", `Play ${s.title}`);
      r.addEventListener("click", (event) => {
        if (event.target.closest("button, select, option")) return;
        toggleSong(s, list, el.id);
      });
      r.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleSong(s, list, el.id);
      });
    }
    el.append(r);
  });
  updateActiveSong();
}
function renderLibrary() {
  const container = $("#songs");
  const count = $("#libraryCount");
  const categoryContainer = $("#libraryCategories");
  categoryContainer.innerHTML = "";
  if (!user) {
    count.textContent = "Sign in to save your favorite tracks.";
    container.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "library-empty";
    empty.innerHTML =
      "<b>Your saved music will appear here.</b><span>Log in with a Premium account to like songs and build your library.</span>";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Log in / Create account";
    button.onclick = () => showAccountGate();
    empty.append(button);
    container.append(empty);
    return;
  }
  const likedSongs = songs.filter((song) => song.liked);
  const privateCategories = categories.filter(
    (category) => category.ownerId === user.id,
  );
  const savedCategories = categories.filter((category) => category.liked);
  const libraryCategories = [
    ...privateCategories,
    ...savedCategories.filter(
      (category) =>
        !privateCategories.some((owned) => owned.id === category.id),
    ),
  ];
  count.textContent = `${likedSongs.length} saved ${likedSongs.length === 1 ? "track" : "tracks"} · ${savedCategories.length}/10 saved categories`;
  if (!likedSongs.length) {
    container.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "library-empty";
    empty.innerHTML =
      "<b>Your library is ready.</b><span>Tap the heart on any song to save it here.</span>";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Browse songs";
    button.onclick = () => view("home");
    empty.append(button);
    container.append(empty);
  } else {
    rows(container, likedSongs);
  }
  if (!libraryCategories.length) return;
  const title = document.createElement("div");
  title.className = "library-category-heading";
  title.innerHTML =
    "<p class=\"eye\">YOUR COLLECTION</p><h2>Your categories</h2><span>Created categories and up to 10 saved favorites</span>";
  categoryContainer.append(title);
  libraryCategories.forEach((category) => {
    const categorySongs = songs.filter((song) =>
      (song.categoryIds || []).includes(category.id),
    );
    const shelf = document.createElement("section");
    shelf.className = "home-song-shelf library-category-shelf";
    shelf.dataset.categoryId = category.id;
    const heading = document.createElement("div");
    heading.className = "shelf-heading";
    const name = document.createElement("h2");
    name.textContent = category.name;
    const total = document.createElement("span");
    total.className = "library-category-count";
    const isOwned = category.ownerId === user.id;
    total.textContent = `${categorySongs.length}/50 tracks · ${isOwned ? "Created by you" : "♥ Saved category"}`;
    heading.append(name, total);
    if (category.liked) {
      const unlike = document.createElement("button");
      unlike.className = "library-category-unlike";
      unlike.type = "button";
      unlike.innerHTML = '<span aria-hidden="true">♥</span> Remove from Library';
      unlike.title = `Unlike ${category.name} and remove it from Your Library`;
      unlike.setAttribute("aria-label", unlike.title);
      unlike.onclick = () => likeCategory(category);
      heading.append(unlike);
    }
    const row = document.createElement("div");
    row.className =
      "cards horizontal-scroll-row category-track-container library-category-track-row";
    categorySongs.forEach((song) =>
      row.append(
        createHomeSongCard(song, categorySongs, `library:${category.id}`),
      ),
    );
    if (!categorySongs.length) {
      const empty = document.createElement("div");
      empty.className = "home-filter-empty";
      empty.textContent = "No songs assigned to this category yet.";
      row.append(empty);
    }
    shelf.append(heading, row);
    categoryContainer.append(shelf);
  });
}
function syncFreeUploadCapacityFromManagedUploads() {
  if (!user || user.canManage) return;
  const owned = managedUploads.filter(
    (song) => song.ownerId === user.id || song.uploadedBy === user.id,
  );
  user.freeApprovedUploadCount = owned.filter(
    (song) => !song.status || song.status === "approved",
  ).length;
  user.freePendingUploadCount = owned.filter(
    (song) => song.status === "pending",
  ).length;
}
function renderFreeUploadCapacity() {
  const form = $("#form");
  const notice = $("#freeUploadCapacity");
  if (!form || !notice) return;
  const isCapacityLimited = Boolean(user && !user.canManage && !user.banned);
  if (!isCapacityLimited) {
    notice.hidden = true;
    form.dataset.capacityLocked = "false";
    form.classList.remove("upload-capacity-locked");
    form.querySelectorAll("input, button").forEach(
      (control) => (control.disabled = false),
    );
    return;
  }
  const approved = Number(user.freeApprovedUploadCount || 0);
  const pending = Number(user.freePendingUploadCount || 0);
  const approvedLimit = Number(user.freeApprovedUploadLimit || 100);
  const pendingLimit = Number(user.freePendingUploadLimit || 5);
  const approvedFull = approved >= approvedLimit;
  const pendingFull = pending >= pendingLimit;
  const locked = approvedFull || pendingFull;
  notice.hidden = false;
  notice.classList.toggle("capacity-locked", locked);
  notice.textContent = approvedFull
    ? "Your live approved catalog is full (Max 100). Delete an approved song to unlock a new upload slot."
    : pendingFull
      ? "Your pending review queue is full (Max 5). Wait for Admin approval."
      : `Approved: ${approved}/${approvedLimit} · Pending review: ${pending}/${pendingLimit}`;
  form.dataset.capacityLocked = String(locked);
  form.classList.toggle("upload-capacity-locked", locked);
  form.querySelectorAll("input, button").forEach(
    (control) => (control.disabled = locked),
  );
}
function render() {
  renderLibrary();
  rows($("#results"), songs);
  renderCategoryRankings();
  renderHomeSongRows();
  $("#count").textContent = songs.length;
  renderUploadCategories();
  renderUploadedSongsManager();
  renderFreeUploadCapacity();
  renderMyCategoriesManager();
  renderRecommendations();
  renderCategories();
  renderCreatorStats();
  renderManagerAccountFilter();
  if (nextUpIds.some((id) => !songs.some((song) => song.id === id)))
    fillNextUp(nextUpIds);
  else renderNextUp();
  updateActiveSong();
}
function creatorTotals(songList = songs, categoryList = categories) {
  if (!user) return { songLikes: 0, categoryLikes: 0 };
  return {
    songLikes: songList
      .filter((song) => song.ownerId === user.id)
      .reduce((total, song) => total + Number(song.likedCount || 0), 0),
    categoryLikes: categoryList
      .filter((category) => category.ownerId === user.id)
      .reduce((total, category) => total + Number(category.likedCount || 0), 0),
  };
}
function renderCreatorStats(songList = songs, categoryList = categories) {
  const totals = creatorTotals(songList, categoryList);
  $("#creatorSongLikes").textContent = totals.songLikes.toLocaleString();
  $("#creatorCategoryLikes").textContent =
    totals.categoryLikes.toLocaleString();
  $(".creator-stats").classList.toggle("guest-stats", !user);
}
async function syncCreatorStats() {
  if (!user || document.hidden) return;
  try {
    const [songsResponse, categoriesResponse, profileResponse] = await Promise.all([
      apiFetch(`/api/songs?page=1&limit=${SONG_PAGE_SIZE}`),
      apiFetch("/api/categories"),
      apiFetch("/api/auth/me"),
    ]);
    if (!songsResponse.ok || !categoriesResponse.ok) return;
    const [latestSongs, latestCategories] = await Promise.all([
      songsResponse.json(),
      categoriesResponse.json(),
    ]);
    if (profileResponse.ok) {
      const latestProfile = await profileResponse.json();
      const permissionsChanged =
        user.canManage !== latestProfile.canManage ||
        user.banned !== latestProfile.banned;
      Object.assign(user, latestProfile);
      renderBoostMilestones();
      renderFreeUploadCapacity();
      if (permissionsChanged) updateProfile();
    }
    let requiresRender = false;
    latestSongs.forEach((latest) => {
      const existing = songs.find((song) => song.id === latest.id);
      if (existing) {
        const likeIsPending = pendingLikeUpdates.has(
          likeUpdateKey("song", existing.id),
        );
        const likeChanged =
          !likeIsPending &&
          (existing.liked !== latest.liked ||
            existing.likedCount !== latest.likedCount);
        if (
          existing.hasGold !== latest.hasGold ||
          existing.hasSilver !== latest.hasSilver
        ) requiresRender = true;
        Object.assign(existing, {
          ...(!likeIsPending
            ? {
                liked: latest.liked,
                likedCount: latest.likedCount,
                selfLikeExcluded: latest.selfLikeExcluded,
              }
            : {}),
          hasGold: latest.hasGold,
          hasSilver: latest.hasSilver,
          goldBoosted: latest.goldBoosted,
          silverBoosted: latest.silverBoosted,
        });
        if (likeChanged) updateSongLikeElements(existing);
      }
    });
    latestCategories.forEach((latest) => {
      const existing = categories.find((category) => category.id === latest.id);
      if (existing) {
        const likeIsPending = pendingLikeUpdates.has(
          likeUpdateKey("category", existing.id),
        );
        const likeChanged =
          !likeIsPending &&
          (existing.liked !== latest.liked ||
            existing.likedCount !== latest.likedCount);
        if (
          existing.name !== latest.name ||
          existing.hasGold !== latest.hasGold ||
          existing.hasSilver !== latest.hasSilver
        ) requiresRender = true;
        Object.assign(existing, {
          ...(!likeIsPending
            ? {
                liked: latest.liked,
                likedCount: latest.likedCount,
                selfLikeExcluded: latest.selfLikeExcluded,
              }
            : {}),
          hasGold: latest.hasGold,
          hasSilver: latest.hasSilver,
          goldBoosted: latest.goldBoosted,
          silverBoosted: latest.silverBoosted,
          name: latest.name,
        });
        if (likeChanged) updateCategoryLikeElements(existing);
      }
    });
    renderCreatorStats(latestSongs, latestCategories);
    if (requiresRender) render();
  } catch {
    // Keep the last known totals visible while the local server reconnects.
  }
}
setInterval(syncCreatorStats, 2000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncCreatorStats();
});
function openManagerSection(sectionId) {
  if (!user) return showAuth(true);
  view("upload");
  requestAnimationFrame(() => {
    const target = $(`#${sectionId}`);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.focus({ preventScroll: true });
    target.classList.remove("manager-focus");
    requestAnimationFrame(() => target.classList.add("manager-focus"));
  });
}
function renderManagerAccountFilter() {
  const banner = $("#managerAccountFilter");
  if (!banner) return;
  const active = user?.adminMode === "master" && managerAccountFilter;
  banner.hidden = !active;
  $("#managerAccountFilterEmail").textContent = active
    ? managerAccountFilter.email || "Unknown account"
    : "";
  const banned = Boolean(active && managerAccountFilter.banned);
  const checking = Boolean(active && managerAccountFilter.checkingBanStatus);
  const status = $("#managerAccountBanStatus");
  status.hidden = !banned;
  status.textContent = banned
    ? `🔴 BANNED: ${managerAccountFilter.banReference || "Banned account"} - Reason: ${managerAccountFilter.banReason || "No reason recorded"}`
    : "";
  $("#banFilteredAccount").hidden = !active || banned || checking;
  $("#unbanFilteredAccount").hidden = !banned;
}
async function refreshManagerAccountBanStatus() {
  if (user?.adminMode !== "master" || !managerAccountFilter?.id) return;
  const targetId = managerAccountFilter.id;
  managerAccountFilter.checkingBanStatus = true;
  renderManagerAccountFilter();
  const response = await apiFetch("/api/admin/reports-bans", {
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!managerAccountFilter || managerAccountFilter.id !== targetId) return;
  managerAccountFilter.checkingBanStatus = false;
  if (response.ok) {
    const record = (data.bannedUsers || []).find(
      (account) => account.id === targetId,
    );
    managerAccountFilter.banned = Boolean(record);
    managerAccountFilter.banReference = record?.banReference || null;
    managerAccountFilter.banReason = record?.banReason || null;
  }
  renderManagerAccountFilter();
}
async function openManagerForAccount(id, email) {
  if (user?.adminMode !== "master" || !id) return;
  managerAccountFilter = {
    id,
    email: email || "Unknown account",
    checkingBanStatus: true,
  };
  hideModals();
  view("upload");
  renderUploadedSongsManager();
  renderMyCategoriesManager();
  renderManagerAccountFilter();
  await refreshManagerAccountBanStatus();
  requestAnimationFrame(() => {
    $("#managerAccountFilter").scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });
}
$("#clearManagerAccountFilter").onclick = () => {
  managerAccountFilter = null;
  renderUploadedSongsManager();
  renderMyCategoriesManager();
  renderManagerAccountFilter();
};
let adminUiPromise = null;
function purgeAdminUi() {
  const previewAudio = $("#pendingPreviewAudio");
  if (previewAudio) previewAudio.pause();
  ["adminHubModal", "freeUploadsModal", "banAccountModal"].forEach((id) =>
    document.getElementById(id)?.remove(),
  );
  pendingPreviewId = null;
  banAccountTarget = null;
}
function bindAdminUi() {
  const codeForm = $("#adminCodeForm");
  const premiumCodeForm = $("#premiumCodeForm");
  const manualBan = $("#manualBanButton");
  const banForm = $("#banAccountForm");
  const previewAudio = $("#pendingPreviewAudio");
  if (!codeForm || !premiumCodeForm || !manualBan || !banForm || !previewAudio)
    return false;
  codeForm.onsubmit = handleAdminCodeSubmit;
  premiumCodeForm.onsubmit = handlePremiumCodeSubmit;
  manualBan.onclick = () => openBanAccountModal();
  banForm.onsubmit = handleBanAccountSubmit;
  previewAudio.addEventListener("ended", handlePendingPreviewEnded);
  $$("#adminHubModal .modal-close, #freeUploadsModal .modal-close, #banAccountModal .modal-close").forEach(
    (button) => (button.onclick = purgeAdminUi),
  );
  return true;
}
async function ensureAdminUi() {
  if (user?.adminMode !== "master") return false;
  if ($("#adminHubModal")) return true;
  if (adminUiPromise) return adminUiPromise;
  adminUiPromise = (async () => {
    const response = await apiFetch("/api/admin/ui", { cache: "no-store" });
    if (!response.ok) {
      await handleLocked(response);
      return false;
    }
    const fragment = await response.text();
    if (user?.adminMode !== "master") return false;
    document.body.insertAdjacentHTML("beforeend", fragment);
    return bindAdminUi();
  })();
  try {
    return await adminUiPromise;
  } finally {
    adminUiPromise = null;
  }
}
async function openBanAccountModal(target = null) {
  if (user?.adminMode !== "master") return;
  if (!(await ensureAdminUi())) return;
  banAccountTarget = target?.id ? target : null;
  $("#banAccountForm").reset();
  $("#banAccountMessage").textContent = "";
  const fixedTarget = Boolean(banAccountTarget);
  $("#banAccountEmailLabel").hidden = fixedTarget;
  $("#banAccountEmail").required = !fixedTarget;
  $("#banAccountEmail").value = fixedTarget ? banAccountTarget.email || "" : "";
  $("#banAccountTargetText").textContent = fixedTarget
    ? `Ban ${banAccountTarget.email || "this account"}. Their active session will be revoked immediately.`
    : "Enter an account email and record the moderation decision.";
  $("#banAccountModal").hidden = false;
  (fixedTarget ? $("#banAccountReference") : $("#banAccountEmail")).focus();
}
$("#banFilteredAccount").onclick = () =>
  managerAccountFilter && openBanAccountModal(managerAccountFilter);
$("#unbanFilteredAccount").onclick = async () => {
  if (!managerAccountFilter?.banned) return;
  if (!confirm(`Unban ${managerAccountFilter.email || "this account"}?`)) return;
  const button = $("#unbanFilteredAccount");
  button.disabled = true;
  try {
    const response = await apiFetch(
      `/api/admin/users/${managerAccountFilter.id}/unban`,
      { method: "POST" },
    );
    if (!response.ok) return handleLocked(response);
    managerAccountFilter.banned = false;
    managerAccountFilter.banReference = null;
    managerAccountFilter.banReason = null;
    renderManagerAccountFilter();
    await load();
  } finally {
    button.disabled = false;
  }
};
$("#songStatsLink").onclick = () => openManagerSection("uploadedSongsSection");
$("#categoryStatsLink").onclick = () =>
  openManagerSection("categoriesManagerSection");
async function deleteCategory(categoryId, categoryName) {
  if (
    !confirm(
      `Delete the category "${categoryName}"? Its songs will stay on this PC.`,
    )
  )
    return;
  const response = await apiFetch(`/api/categories/${categoryId}`, {
    method: "DELETE",
  });
  if (!response.ok) return handleLocked(response);
  if (homeCategoryFilter === categoryId) homeCategoryFilter = "all";
  if (activeCategory?.id === categoryId) activeCategory = null;
  await load();
}
function likeCategory(category) {
  if (!user) return showAccountGate();
  if (!canLikeSongs()) return showPremium(true);
  queueOptimisticLike(category, "category");
}
function manageableCategories() {
  if (!user?.canManage) return [];
  return user.adminMode === "master"
    ? categories
    : categories.filter((category) => category.ownerId === user.id);
}
function categoryTrackCount(categoryId) {
  return songs.filter((song) => (song.categoryIds || []).includes(categoryId))
    .length;
}
async function assignSongCategory(song, categoryId, select) {
  const previousCategoryIds = [...(song.categoryIds || [])];
  const ownedIds = new Set(
    manageableCategories().map((category) => category.id),
  );
  const retainedIds = previousCategoryIds.filter((id) => !ownedIds.has(id));
  const requestedIds = categoryId ? [categoryId] : [];
  const response = await apiFetch(`/api/songs/${song.id}/categories`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categoryIds: requestedIds }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    select.value = previousCategoryIds.find((id) => ownedIds.has(id)) || "";
    if (data.code === "CATEGORY_FULL")
      return alert("This category is full. It already contains 50 songs.");
    if (data.code === "CATEGORY_NOT_OWNED")
      return alert("You can only use categories that you created.");
    return alert(data.error || "The category could not be updated.");
  }
  const updated = await response.json();
  song.categoryIds = updated.categoryIds || [...retainedIds, ...requestedIds];
  render();
}
function saveHiddenDefaultRows() {
  localStorage.setItem(
    "d50_hidden_default_rows",
    JSON.stringify([...hiddenDefaultRows]),
  );
  $("#restoreDefaultRows").hidden =
    hiddenDefaultRows.size === 0 || user?.adminMode !== "master";
}
function hideDefaultRow(rowId, rowTitle) {
  if (user?.adminMode !== "master") return;
  if (
    !confirm(`Hide "${rowTitle}" from Home? Your songs will remain on this PC.`)
  )
    return;
  hiddenDefaultRows.add(rowId);
  saveHiddenDefaultRows();
  renderHomeSongRows();
}
const restoreDefaultRowsButton = $("#restoreDefaultRows");
if (restoreDefaultRowsButton) restoreDefaultRowsButton.onclick = () => {
  hiddenDefaultRows.clear();
  saveHiddenDefaultRows();
  renderHomeSongRows();
};
function renderCategoryFilters() {
  const filters = $("#categoryFilters");
  const categoryQuery = $("#categorySearch").value.trim().toLowerCase();
  if (
    homeCategoryFilter !== "all" &&
    !categories.some((category) => category.id === homeCategoryFilter)
  ) {
    homeCategoryFilter = "all";
  }
  filters.innerHTML = "";
  const addPill = (id, label, category = null) => {
    const wrapper = document.createElement("span");
    wrapper.className = "filter-pill-wrap";
    if (category) wrapper.dataset.categoryId = category.id;
    const button = document.createElement("button");
    button.className = "filter-pill";
    button.classList.toggle("active", homeCategoryFilter === id);
    button.textContent = label;
    button.onclick = () => {
      homeCategoryFilter =
        id !== "all" && homeCategoryFilter === id ? "all" : id;
      render();
    };
    wrapper.append(button);
    if (category) {
      const likeButton = document.createElement("button");
      likeButton.className = "category-pill-like";
      likeButton.type = "button";
      likeButton.disabled = !canLikeSongs();
      likeButton.textContent = category.liked ? "♥" : "♡";
      likeButton.classList.toggle("liked", !!category.liked);
      likeButton.setAttribute(
        "aria-label",
        `${category.liked ? "Unlike" : "Like"} ${label}`,
      );
      likeButton.title = likeTitle(category, "category");
      likeButton.onclick = (event) => {
        event.stopPropagation();
        likeCategory(category);
      };
      wrapper.append(likeButton);
      if (user?.adminMode === "master") {
        const accountShortcut = document.createElement("button");
        accountShortcut.type = "button";
        accountShortcut.className = "filter-account-shortcut";
        accountShortcut.textContent = "A";
        accountShortcut.title = `View content owned by ${category.ownerEmail || "this account"}`;
        accountShortcut.onclick = (event) => {
          event.stopPropagation();
          openManagerForAccount(category.ownerId, category.ownerEmail);
        };
        wrapper.append(accountShortcut);
      }
    }
    const canDeleteCategory =
      category &&
      user?.canManage &&
      user.adminMode !== "master" &&
      category.ownerId === user.id;
    if (canDeleteCategory) {
      const remove = document.createElement("button");
      remove.className = "filter-pill-delete";
      remove.type = "button";
      remove.setAttribute("aria-label", `Delete ${label}`);
      remove.title = `Delete ${label}`;
      remove.textContent = "×";
      remove.onclick = () => deleteCategory(id, label);
      wrapper.append(remove);
    }
    filters.append(wrapper);
  };
  if (!categoryQuery) addPill("all", "All");
  categories
    .filter((category) => category.name.toLowerCase().includes(categoryQuery))
    .forEach((category) => addPill(category.id, category.name, category));
  if (!filters.children.length) {
    const empty = document.createElement("small");
    empty.className = "category-search-empty";
    empty.textContent = "No matching categories";
    filters.append(empty);
  }
  const selected = categories.find(
    (category) => category.id === homeCategoryFilter,
  );
}
const categorySearchInput = $("#categorySearch");
if (categorySearchInput) categorySearchInput.oninput = renderCategoryFilters;
function shuffledCategoryIds(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [
      shuffled[randomIndex],
      shuffled[index],
    ];
  }
  return shuffled.slice(0, 10).map((category) => category.id);
}
function appendAdminBoostHearts(card, item) {
  const awards = [
    {
      active: Boolean(item.hasGold || item.goldBoosted),
      tier: "gold",
      title: "Master Admin Gold Boost",
    },
    {
      active: Boolean(item.hasSilver || item.silverBoosted),
      tier: "silver",
      title: "Master Admin Silver Boost",
    },
  ].filter((award) => award.active);
  card.classList.toggle(
    "gold-featured",
    awards.some((award) => award.tier === "gold"),
  );
  card.classList.toggle(
    "silver-featured",
    awards.some((award) => award.tier === "silver"),
  );
  card.classList.toggle("has-admin-boost", awards.length > 0);
  if (!awards.length) return;
  const tray = document.createElement("span");
  tray.className = "admin-boost-heart-tray";
  awards.forEach((award) => {
    const heart = document.createElement("span");
    heart.className = `active-admin-boost ${award.tier}`;
    heart.textContent = "♥";
    heart.title = award.title;
    tray.append(heart);
  });
  card.append(tray);
}
function appendManagerAccountShortcut(card, item, extraClass = "") {
  const ownerId = item?.ownerId || item?.uploadedBy;
  if (user?.adminMode !== "master" || !ownerId) return;
  const shortcut = document.createElement("button");
  shortcut.type = "button";
  shortcut.className = `account-manager-shortcut ${extraClass}`.trim();
  shortcut.textContent = "A";
  shortcut.title = `View content owned by ${item.ownerEmail || "this account"}`;
  shortcut.setAttribute("aria-label", shortcut.title);
  shortcut.onclick = (event) => {
    event.stopPropagation();
    openManagerForAccount(ownerId, item.ownerEmail);
  };
  card.classList.add("has-account-shortcut");
  card.append(shortcut);
}
function createCategoryRankingCard(category) {
  const card = document.createElement("div");
  card.className = "category-ranking-card";
  card.dataset.categoryId = category.id;
  const isOpen = homeCategoryFilter === category.id;
  card.classList.toggle("is-open", isOpen);
  card.dataset.reportId = category.id;
  card.dataset.reportName = category.name;
  card.dataset.reportType = "category";
  if (category.coverUrl) {
    card.classList.add("has-category-cover");
    card.style.backgroundImage = `linear-gradient(180deg, transparent 25%, #080611ee 100%), url("${category.coverUrl}")`;
  }
  const open = document.createElement("button");
  open.className = "category-ranking-open";
  open.type = "button";
  open.setAttribute("aria-pressed", String(isOpen));
  open.innerHTML = "<i>◆</i><b></b><small></small>";
  open.querySelector("b").textContent = category.name;
  open.querySelector("small").textContent =
    `${category.likedCount || 0} ${category.likedCount === 1 ? "like" : "likes"}`;
  open.onclick = () => {
    homeCategoryFilter =
      homeCategoryFilter === category.id ? "all" : category.id;
    renderCategoryRankings();
    renderHomeSongRows();
    requestAnimationFrame(() =>
      $("#homeSongRows")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      }),
    );
  };
  if (isOpen) {
    const viewing = document.createElement("span");
    viewing.className = "category-viewing-badge";
    viewing.textContent = "Viewing";
    card.append(viewing);
  }
  const heart = document.createElement("button");
  heart.className = "category-card-like";
  heart.type = "button";
  heart.disabled = !canLikeSongs();
  heart.textContent = category.liked ? "♥" : "♡";
  heart.classList.toggle("liked", !!category.liked);
  heart.setAttribute(
    "aria-label",
    `${category.liked ? "Unlike" : "Like"} ${category.name}`,
  );
  heart.title = likeTitle(category, "category");
  heart.onclick = () => likeCategory(category);
  appendAdminBoostHearts(card, category);
  card.append(open, heart);
  appendManagerAccountShortcut(card, category);
  return card;
}
function boostRank(item) {
  if (item.hasGold || item.goldBoosted) return 2;
  if (item.hasSilver || item.silverBoosted) return 1;
  return 0;
}
function renderCategoryRankings(refreshDiscoveries = false) {
  const container = $("#categoryRankings");
  container.innerHTML = "";
  if (!categories.length) {
    categoryDiscoveryIds = [];
    return;
  }
  const ranked = [...categories].sort(
    (first, second) =>
      boostRank(second) - boostRank(first) ||
      (second.likedCount || 0) - (first.likedCount || 0) ||
      first.name.localeCompare(second.name),
  );
  const top = ranked.slice(0, 10);
  const discoveryPool = categories;
  const expectedDiscoveryCount = Math.min(10, discoveryPool.length);
  const validDiscoveryIds = new Set(
    discoveryPool.map((category) => category.id),
  );
  if (
    refreshDiscoveries ||
    categoryDiscoveryIds.length !== expectedDiscoveryCount ||
    categoryDiscoveryIds.some((id) => !validDiscoveryIds.has(id))
  ) {
    categoryDiscoveryIds = shuffledCategoryIds(discoveryPool);
  }
  const discoveries = categoryDiscoveryIds
    .map((id) => categories.find((category) => category.id === id))
    .filter(Boolean);
  const addRow = (title, items, refreshable = false) => {
    if (!items.length) return;
    const shelf = document.createElement("section");
    shelf.className = "category-ranking-shelf";
    const headingBar = document.createElement("div");
    headingBar.className = "category-ranking-heading";
    const heading = document.createElement("h2");
    heading.textContent = title;
    headingBar.append(heading);
    if (refreshable) {
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "category-discovery-refresh";
      refresh.innerHTML = '<span aria-hidden="true">↻</span> Refresh';
      refresh.setAttribute("aria-label", "Refresh random category discoveries");
      refresh.title = "Mix 10 new category discoveries";
      refresh.onclick = () => renderCategoryRankings(true);
      headingBar.append(refresh);
    }
    const row = document.createElement("div");
    row.className = "category-ranking-row horizontal-scroll-row";
    items.forEach((category) =>
      row.append(createCategoryRankingCard(category)),
    );
    shelf.append(headingBar, row);
    container.append(shelf);
  };
  addRow("Top 10 most liked categories", top);
  addRow("10 random discoveries", discoveries, true);
}
function createHomeSongCard(song, rowSongs, scopeName) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.songId = song.id;
  card.dataset.reportId = song.id;
  card.dataset.reportName = song.title;
  card.dataset.reportType = "song";
  card.innerHTML =
    '<i>◎</i><button class="card-play" aria-label="Play">▶</button><button class="card-delete" aria-label="Delete song" title="Delete song">🗑</button><b></b><small>Local upload · D50</small><div class="card-like-wrap"><button class="heart" aria-label="Like song">♡</button><span class="song-like-count">0</span></div><select class="category-select"><option value="">No category</option></select>';
  card.querySelector("b").textContent = song.title;
  appendAdminBoostHearts(card, song);
  const artwork = card.querySelector("i");
  if (song.coverUrl) {
    artwork.classList.add("custom-cover-art");
    artwork.textContent = "";
    artwork.style.backgroundImage = `url("${song.coverUrl}")`;
  }
  const picker = card.querySelector("select");
  const deleteButton = card.querySelector(".card-delete");
  deleteButton.remove();
  const availableCategories = manageableCategories();
  picker.hidden = !user?.canManage || !availableCategories.length;
  availableCategories.forEach((category) => {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent = category.name;
    option.selected = (song.categoryIds || []).includes(category.id);
    picker.append(option);
  });
  picker.onclick = (event) => event.stopPropagation();
  picker.onchange = (event) => {
    event.stopPropagation();
    assignSongCategory(song, picker.value, picker);
  };
  picker.after(createQueueInjector(song));
  const likeButton = card.querySelector(".heart");
  likeButton.textContent = song.liked ? "♥" : "♡";
  likeButton.classList.toggle("liked", !!song.liked);
  likeButton.disabled = !canLikeSongs();
  likeButton.title = likeTitle(song);
  likeButton.onclick = (event) => {
    event.stopPropagation();
    like(song);
  };
  card.querySelector(".song-like-count").textContent = song.likedCount || 0;
  card.onclick = () => toggleSong(song, rowSongs, scopeName);
  appendManagerAccountShortcut(card, song, "song-account-shortcut");
  return card;
}
function renderHomeSongRows() {
  const container = $("#homeSongRows");
  container.innerHTML = "";
  const trending = [...songs].sort((first, second) => {
    const boostDifference = boostRank(second) - boostRank(first);
    if (boostDifference) return boostDifference;
    const likeDifference =
      Number(second.likedCount || 0) - Number(first.likedCount || 0);
    if (likeDifference) return likeDifference;
    return Number(second.createdAt || 0) - Number(first.createdAt || 0);
  });
  const selectedCategory = categories.find(
    (category) => category.id === homeCategoryFilter,
  );
  if (homeCategoryFilter !== "all" && !selectedCategory)
    homeCategoryFilter = "all";
  const rowsToShow = selectedCategory
    ? [
        {
          id: `category:${selectedCategory.id}`,
          title: selectedCategory.name,
          categoryId: selectedCategory.id,
          songs: songs.filter((song) =>
            (song.categoryIds || []).includes(selectedCategory.id),
          ),
        },
      ]
    : [
        { id: "recent", title: "Recently uploaded", songs },
        { id: "trending", title: "Trending AI Hits", songs: trending },
      ];
  rowsToShow.forEach((definition) => {
    const shelf = document.createElement("section");
    shelf.className = "home-song-shelf";
    const heading = document.createElement("div");
    heading.className = "shelf-heading";
    const title = document.createElement("h2");
    title.textContent = definition.title;
    heading.append(title);
    if (definition.categoryId) {
      const close = document.createElement("button");
      close.className = "shelf-delete";
      close.type = "button";
      close.textContent = "×";
      close.title = "Close category row";
      close.setAttribute("aria-label", `Close ${definition.title}`);
      close.onclick = () => {
        homeCategoryFilter = "all";
        renderCategoryRankings();
        renderHomeSongRows();
      };
      heading.append(close);
    }
    const row = document.createElement("div");
    row.className = `cards horizontal-scroll-row dashboard-song-row ${
      definition.categoryId
        ? "category-track-container"
        : definition.id === "recent"
        ? "recently-uploaded-container"
        : "trending-container"
    }`;
    definition.songs.forEach((song) =>
      row.append(createHomeSongCard(song, definition.songs, definition.id)),
    );
    if (!definition.songs.length) {
      const empty = document.createElement("div");
      empty.className = "home-filter-empty";
      empty.textContent = definition.categoryId
        ? "No songs assigned to this category yet."
        : "No songs uploaded yet.";
      row.append(empty);
    }
    shelf.append(heading, row);
    container.append(shelf);
  });
}
function renderUploadCategories() {
  const container = $("#uploadCategoryChoices");
  container.innerHTML = "";
  const availableCategories = manageableCategories();
  if (!availableCategories.length) {
    const note = document.createElement("small");
    note.className = "category-empty-note";
    note.textContent = "Create a category in the sidebar first!";
    container.append(note);
    return;
  }
  availableCategories.forEach((category) => {
    const label = document.createElement("label");
    label.className = "category-checkbox";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "categoryIds";
    checkbox.value = category.id;
    checkbox.onchange = () => {
      if (checkbox.checked && categoryTrackCount(category.id) >= 50) {
        checkbox.checked = false;
        alert("This category is full. It already contains 50 songs.");
        return;
      }
      if (checkbox.checked) managerCategoryPriority = category.id;
      else if (managerCategoryPriority === category.id) {
        const remaining = [
          ...container.querySelectorAll('input[name="categoryIds"]:checked'),
        ];
        managerCategoryPriority = remaining.at(-1)?.value || null;
      }
      renderUploadedSongsManager();
      requestAnimationFrame(() =>
        $("#uploadedSongsSection").scrollIntoView({
          behavior: "smooth",
          block: "start",
        }),
      );
    };
    const text = document.createElement("span");
    text.textContent = category.name;
    label.append(checkbox, text);
    container.append(label);
  });
}
async function updateManagedSongCategories(
  song,
  checkedCategoryIds,
  changedBox,
) {
  const response = await apiFetch(`/api/songs/${song.id}/categories`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categoryIds: checkedCategoryIds }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (changedBox) changedBox.checked = !changedBox.checked;
    if (data.code === "CATEGORY_FULL")
      return alert("This category is full. It already contains 50 songs.");
    return alert(data.error || "The categories could not be updated.");
  }
  const updated = await response.json();
  song.categoryIds = updated.categoryIds || [];
  render();
}
async function changeManagedSongCover(song, fileInput) {
  const file = fileInput.files[0];
  if (!file) return;
  if (!/\.(?:jpe?g|png)$/i.test(file.name)) {
    fileInput.value = "";
    return alert("Choose a JPG or PNG cover image.");
  }
  if (file.size > 2 * 1024 * 1024) {
    fileInput.value = "";
    return alert("The cover image must be 2 MB or smaller.");
  }
  const data = new FormData();
  data.append("cover", file);
  const response = await apiFetch(`/api/songs/${song.id}/cover`, {
    method: "PATCH",
    body: data,
  });
  const result = await response.json().catch(() => ({}));
  fileInput.value = "";
  if (!response.ok)
    return alert(result.error || "The cover could not be changed.");
  const index = songs.findIndex((item) => item.id === song.id);
  if (index >= 0) songs[index] = result;
  render();
}
function canDeleteSong(song) {
  return Boolean(
    user?.adminMode === "master" ||
    song.ownerId === user?.id ||
    song.uploadedBy === user?.id,
  );
}
async function deleteSong(song) {
  if (!canDeleteSong(song)) return;
  const isModeratingAnotherUser =
    user.adminMode === "master" &&
    (song.ownerId || song.uploadedBy) !== user.id;
  let reason = "";
  if (isModeratingAnotherUser) {
    reason = prompt("Reason for removal / Warning message for this user?", "");
    if (reason === null) return;
    reason = cleanText(reason, 500);
    if (!reason) return alert("A warning reason is required.");
  } else if (
    !confirm(`Permanently delete “${song.title}” and its audio file?`)
  ) {
    return;
  }
  const response = await apiFetch(`/api/songs/${song.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!response.ok) return handleLocked(response);
  if (currentId === song.id) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    currentId = null;
    queue = [];
    nextUpIds = [];
  }
  await load();
}
const deleteManagedSong = deleteSong;
function renderUploadedSongsManager() {
  const container = $("#uploadedSongsManager");
  if (!container) return;
  container.innerHTML = "";
  let uploadedSongs = user
    ? user.adminMode === "master"
      ? managerAccountFilter
        ? songs.filter(
            (song) =>
              song.ownerId === managerAccountFilter.id ||
              song.uploadedBy === managerAccountFilter.id,
          )
        : songs
      : managedUploads
    : [];
  uploadedSongs = [...uploadedSongs].sort((first, second) => {
    if (!managerCategoryPriority) return 0;
    const firstMatches = (first.categoryIds || []).includes(
      managerCategoryPriority,
    );
    const secondMatches = (second.categoryIds || []).includes(
      managerCategoryPriority,
    );
    return Number(secondMatches) - Number(firstMatches);
  });
  const priorityCategory = categories.find(
    (category) => category.id === managerCategoryPriority,
  );
  $("#uploadedSongsCount").textContent = `${uploadedSongs.length} ${
    uploadedSongs.length === 1 ? "song" : "songs"
  }${priorityCategory ? ` · ${priorityCategory.name} first` : ""}`;
  if (!uploadedSongs.length) {
    const empty = document.createElement("div");
    empty.className = "manager-empty";
    empty.textContent = "You have not uploaded any songs yet.";
    container.append(empty);
    return;
  }
  const availableCategories = manageableCategories();
  uploadedSongs.forEach((song) => {
    const row = document.createElement("article");
    row.className = "uploaded-song-manager-row";
    row.dataset.songId = song.id;
    row.dataset.reportId = song.id;
    row.dataset.reportName = song.title;
    row.dataset.reportType = "song";
    appendAdminBoostHearts(row, song);

    const cover = document.createElement("div");
    cover.className = "manager-cover";
    cover.textContent = "◎";
    if (song.coverUrl) {
      cover.textContent = "";
      cover.style.backgroundImage = `url("${song.coverUrl}")`;
    }
    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "inline-play manager-cover-play";
    playButton.textContent =
      currentId === song.id && !audio.paused ? "⏸" : "▶";
    playButton.title = `Play ${song.title}`;
    playButton.setAttribute("aria-label", playButton.title);
    playButton.onclick = () =>
      toggleSong(song, uploadedSongs, "uploaded-song-manager");
    cover.append(playButton);

    const details = document.createElement("div");
    details.className = "manager-song-details";
    const title = document.createElement("b");
    title.textContent = song.title;
    const subtitle = document.createElement("small");
    subtitle.textContent = `${song.uploaderName || song.ownerEmail || user.email} · ${song.status === "pending" ? "Pending Master Admin review" : "Approved"}`;
    const likeTotal = document.createElement("span");
    likeTotal.className = "manager-like-total";
    likeTotal.textContent = `♥ ${Number(song.likedCount || 0)} public ${Number(song.likedCount || 0) === 1 ? "like" : "likes"}`;
    details.append(title, subtitle, likeTotal);

    const categoryArea = document.createElement("div");
    categoryArea.className = "manager-category-area";
    categoryArea.hidden = !user?.canManage;
    const categoryTitle = document.createElement("small");
    categoryTitle.textContent = "Categories";
    const checklist = document.createElement("div");
    checklist.className = "manager-category-checklist";
    if (!availableCategories.length) {
      const note = document.createElement("span");
      note.textContent = "No categories created";
      checklist.append(note);
    }
    availableCategories.forEach((category) => {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = category.id;
      checkbox.checked = (song.categoryIds || []).includes(category.id);
      checkbox.onchange = () => {
        if (
          checkbox.checked &&
          !(song.categoryIds || []).includes(category.id) &&
          categoryTrackCount(category.id) >= 50
        ) {
          checkbox.checked = false;
          return alert("This category is full. It already contains 50 songs.");
        }
        const checkedIds = [...checklist.querySelectorAll("input:checked")].map(
          (input) => input.value,
        );
        updateManagedSongCategories(song, checkedIds, checkbox);
      };
      const name = document.createElement("span");
      name.textContent = category.name;
      label.append(checkbox, name);
      checklist.append(label);
    });
    categoryArea.append(categoryTitle, checklist);

    const actions = document.createElement("div");
    actions.className = "manager-actions";
    const coverLabel = document.createElement("label");
    coverLabel.className = "change-cover-button";
    coverLabel.textContent = "Change Cover";
    coverLabel.hidden = !user?.canManage;
    const coverInput = document.createElement("input");
    coverInput.type = "file";
    coverInput.accept = ".jpg,.jpeg,.png,image/jpeg,image/png";
    coverInput.onchange = () => changeManagedSongCover(song, coverInput);
    coverLabel.append(coverInput);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "manager-delete";
    remove.textContent = "🗑";
    remove.title = `Delete ${song.title}`;
    remove.setAttribute("aria-label", `Delete ${song.title}`);
    remove.onclick = () => deleteManagedSong(song);
    remove.hidden = !canDeleteSong(song);
    const likeButton = document.createElement("button");
    likeButton.type = "button";
    likeButton.className = "heart";
    likeButton.textContent = song.liked ? "♥" : "♡";
    likeButton.classList.toggle("liked", !!song.liked);
    likeButton.disabled = !canLikeSongs();
    likeButton.title = likeTitle(song);
    likeButton.onclick = () => like(song);
    actions.append(createQueueInjector(song), likeButton, coverLabel, remove);

    row.append(cover, details, categoryArea, actions);
    container.append(row);
  });
}
function ownedCategoriesOnly() {
  if (!user) return [];
  if (user.adminMode === "master") {
    return managerAccountFilter
      ? categories.filter(
          (category) => category.ownerId === managerAccountFilter.id,
        )
      : categories;
  }
  return categories.filter((category) => category.ownerId === user.id);
}
async function changeCategoryCover(category, fileInput) {
  const file = fileInput.files[0];
  if (!file) return;
  if (!/\.(?:jpe?g|png)$/i.test(file.name)) {
    fileInput.value = "";
    return alert("Choose a JPG or PNG category cover.");
  }
  if (file.size > 2 * 1024 * 1024) {
    fileInput.value = "";
    return alert("The category cover must be 2 MB or smaller.");
  }
  const body = new FormData();
  body.append("categoryCover", file);
  const response = await apiFetch(`/api/categories/${category.id}/cover`, {
    method: "PATCH",
    body,
  });
  const result = await response.json().catch(() => ({}));
  fileInput.value = "";
  if (!response.ok)
    return alert(result.error || "The category cover could not be changed.");
  const index = categories.findIndex((item) => item.id === category.id);
  if (index >= 0) categories[index] = result;
  render();
}
async function removeSongFromCategory(song, category) {
  const remainingOwnedCategoryIds = ownedCategoriesOnly()
    .filter((item) => item.id !== category.id)
    .filter((item) => (song.categoryIds || []).includes(item.id))
    .map((item) => item.id);
  const response = await apiFetch(`/api/songs/${song.id}/categories`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categoryIds: remainingOwnedCategoryIds }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return alert(
      data.error || "The song could not be removed from this category.",
    );
  }
  const updated = await response.json();
  song.categoryIds = updated.categoryIds || [];
  render();
}
function renderMyCategoriesManager() {
  const container = $("#categoriesManager");
  if (!container) return;
  container.innerHTML = "";
  const ownedCategories = ownedCategoriesOnly();
  $("#managedCategoriesCount").textContent = `${ownedCategories.length} ${
    ownedCategories.length === 1 ? "category" : "categories"
  }`;
  if (!ownedCategories.length) {
    const empty = document.createElement("div");
    empty.className = "manager-empty";
    empty.textContent = "Create a category to manage its tracks here.";
    container.append(empty);
    return;
  }
  ownedCategories.forEach((category) => {
    const categorySongs = songs.filter((song) =>
      (song.categoryIds || []).includes(category.id),
    );
    const block = document.createElement("article");
    block.className = "managed-category-block";
    block.dataset.categoryId = category.id;
    block.dataset.reportId = category.id;
    block.dataset.reportName = category.name;
    block.dataset.reportType = "category";
    appendAdminBoostHearts(block, category);
    const heading = document.createElement("div");
    heading.className = "managed-category-heading";
    const name = document.createElement("h3");
    name.textContent = category.name;
    const total = document.createElement("span");
    total.textContent = `${categorySongs.length}/50 ${
      categorySongs.length === 1 ? "track" : "tracks"
    }`;
    const likeTotal = document.createElement("span");
    likeTotal.className = "manager-like-total";
    likeTotal.textContent = `♥ ${Number(category.likedCount || 0)} public ${Number(category.likedCount || 0) === 1 ? "like" : "likes"}`;
    const headingActions = document.createElement("div");
    headingActions.className = "managed-category-actions";
    const changeCover = document.createElement("label");
    changeCover.className = "change-category-cover";
    changeCover.textContent = "Change Category Cover";
    changeCover.hidden = !user?.canManage;
    const coverInput = document.createElement("input");
    coverInput.type = "file";
    coverInput.accept = ".jpg,.jpeg,.png,image/jpeg,image/png";
    coverInput.onchange = () => changeCategoryCover(category, coverInput);
    changeCover.append(coverInput);
    const deleteCategoryButton = document.createElement("button");
    deleteCategoryButton.type = "button";
    deleteCategoryButton.className = "manager-delete-category";
    deleteCategoryButton.textContent = "🗑 Delete Category";
    deleteCategoryButton.title = `Delete ${category.name}`;
    deleteCategoryButton.onclick = () =>
      deleteCategory(category.id, category.name);
    headingActions.append(
      total,
      likeTotal,
      changeCover,
      deleteCategoryButton,
    );
    heading.append(name, headingActions);
    const list = document.createElement("div");
    list.className = "managed-category-tracks";
    if (!categorySongs.length) {
      const empty = document.createElement("p");
      empty.className = "managed-category-empty";
      empty.textContent = "No songs are assigned to this category.";
      list.append(empty);
    }
    categorySongs.forEach((song) => {
      const row = document.createElement("div");
      row.className = "managed-category-track";
      row.dataset.songId = song.id;
      row.dataset.reportId = song.id;
      row.dataset.reportName = song.title;
      row.dataset.reportType = "song";
      appendAdminBoostHearts(row, song);
      const artwork = document.createElement("div");
      artwork.className = "manager-track-cover";
      artwork.textContent = "◎";
      if (song.coverUrl) {
        artwork.textContent = "";
        artwork.style.backgroundImage = `url("${song.coverUrl}")`;
      }
      const playButton = document.createElement("button");
      playButton.type = "button";
      playButton.className = "inline-play";
      playButton.textContent =
        currentId === song.id && !audio.paused ? "⏸" : "▶";
      playButton.setAttribute("aria-label", `Play ${song.title}`);
      playButton.onclick = () =>
        toggleSong(song, categorySongs, `manager-category:${category.id}`);
      artwork.append(playButton);
      const details = document.createElement("span");
      const title = document.createElement("b");
      title.textContent = song.title;
      const source = document.createElement("small");
      source.textContent =
        song.ownerId === user.id || song.uploadedBy === user.id
          ? "Your upload"
          : "D50 global catalog";
      const songLikes = document.createElement("small");
      songLikes.className = "manager-like-total";
      songLikes.textContent = `♥ ${Number(song.likedCount || 0)} public ${Number(song.likedCount || 0) === 1 ? "like" : "likes"}`;
      details.append(title, source, songLikes);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-category-track";
      remove.textContent = "×";
      remove.title = `Remove ${song.title} from ${category.name}`;
      remove.setAttribute(
        "aria-label",
        `Remove ${song.title} from ${category.name}`,
      );
      remove.onclick = () => removeSongFromCategory(song, category);
      remove.hidden = !user?.canManage;
      const likeButton = document.createElement("button");
      likeButton.type = "button";
      likeButton.className = "heart";
      likeButton.textContent = song.liked ? "♥" : "♡";
      likeButton.classList.toggle("liked", !!song.liked);
      likeButton.disabled = !canLikeSongs();
      likeButton.title = likeTitle(song);
      likeButton.onclick = () => like(song);
      row.append(artwork, details, likeButton, remove);
      list.append(row);
    });
    block.append(heading, list);
    container.append(block);
  });
  updateActiveSong();
}
function randomRecommendationIds() {
  const shuffled = [...songs];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [
      shuffled[randomIndex],
      shuffled[index],
    ];
  }
  return shuffled.slice(0, Math.min(5, shuffled.length)).map((song) => song.id);
}
function renderRecommendations(refresh = false) {
  const container = $("#recommendations");
  container.innerHTML = "";
  const expectedCount = Math.min(5, songs.length);
  const selectionIsValid =
    recommendationIds.length === expectedCount &&
    recommendationIds.every((id) => songs.some((song) => song.id === id));
  if (refresh || !selectionIsValid) {
    recommendationIds = randomRecommendationIds();
  }
  const picks = recommendationIds
    .map((id) => songs.find((song) => song.id === id))
    .filter(Boolean);
  if (!picks.length) {
    const empty = document.createElement("p");
    empty.className = "recommendations-empty";
    empty.textContent = "Upload songs to create recommendations.";
    container.append(empty);
    return;
  }
  picks.forEach((song) => {
    const card = document.createElement("div");
    card.className = "recommendation-card";
    card.dataset.songId = song.id;
    card.dataset.reportId = song.id;
    card.dataset.reportName = song.title;
    card.dataset.reportType = "song";
    card.innerHTML =
      '<button class="recommendation-play"><i>◎</i><span><b></b><small>Recommended from D50</small></span><strong>▶</strong></button><button class="heart" aria-label="Like song">♡</button><button class="recommendation-delete" aria-label="Delete song">🗑</button>';
    appendAdminBoostHearts(card, song);
    card.querySelector("b").textContent = song.title;
    card.querySelector(".recommendation-play").onclick = () =>
      toggleSong(song, picks, "recommendations");
    const likeButton = card.querySelector(".heart");
    likeButton.disabled = !canLikeSongs();
    likeButton.title = likeTitle(song);
    likeButton.textContent = song.liked ? "♥" : "♡";
    likeButton.classList.toggle("liked", !!song.liked);
    likeButton.onclick = () => like(song);
    const deleteButton = card.querySelector(".recommendation-delete");
    deleteButton.remove();
    card.append(createQueueInjector(song));
    appendManagerAccountShortcut(
      card,
      song,
      "recommendation-account-shortcut",
    );
    container.append(card);
  });
  updateActiveSong();
}
$("#refreshRecommendations").onclick = () => renderRecommendations(true);
const mobileForYouToggle = $("#mobileForYouToggle");
const recommendationsPanel = $("#recommendationsPanel");

function setMobileRecommendationsOpen(open) {
  const isOpen = Boolean(open);
  recommendationsPanel.classList.toggle("mobile-open", isOpen);
  mobileForYouToggle.setAttribute("aria-expanded", String(isOpen));
  mobileForYouToggle.textContent = "FOR YOU";
}

mobileForYouToggle.onclick = () =>
  setMobileRecommendationsOpen(
    !recommendationsPanel.classList.contains("mobile-open"),
  );

window.addEventListener("resize", () => {
  if (window.innerWidth >= 768) setMobileRecommendationsOpen(false);
});
function renderCategories() {
  if (activeCategory) {
    const list = songs.filter((song) =>
      (song.categoryIds || []).includes(activeCategory.id),
    );
    rows($("#categorySongs"), list);
  }
}
async function load() {
  songPage = 0;
  songsHaveMore = true;
  songsPageLoading = true;
  updateSongLoadStatus();
  const [songsResponse, categoriesResponse, uploadsResponse] = await Promise.all([
    apiFetch(`/api/songs?page=1&limit=${SONG_PAGE_SIZE}`),
    apiFetch("/api/categories"),
    user ? apiFetch("/api/my-uploads") : Promise.resolve(null),
  ]);

  if (
    !songsResponse.ok ||
    !categoriesResponse.ok ||
    (uploadsResponse && !uploadsResponse.ok)
  ) {
    throw new Error("Could not load your private catalog.");
  }

  [songs, categories] = await Promise.all([
    songsResponse.json(),
    categoriesResponse.json(),
  ]);
  songPage = 1;
  songsHaveMore = songsResponse.headers.get("X-Has-More") === "true";
  songsPageLoading = false;
  managedUploads = uploadsResponse ? await uploadsResponse.json() : [];
  syncFreeUploadCapacityFromManagedUploads();
  render();
  updateSongLoadStatus();
}

function updateSongLoadStatus(message = "") {
  const sentinel = $("#songLoadSentinel");
  const status = $("#songLoadStatus");
  if (!sentinel || !status) return;
  sentinel.hidden = !songsHaveMore && !songsPageLoading;
  status.textContent = message || (songsPageLoading
    ? "Loading more songs…"
    : songsHaveMore
      ? "Scroll to load more songs"
      : "All songs loaded");
}

async function loadNextSongPage() {
  if (songsPageLoading || !songsHaveMore) return;
  songsPageLoading = true;
  updateSongLoadStatus();
  const nextPage = songPage + 1;
  try {
    const response = await apiFetch(
      `/api/songs?page=${nextPage}&limit=${SONG_PAGE_SIZE}`,
    );
    if (!response.ok) throw new Error("Could not load more songs.");
    const nextSongs = await response.json();
    const knownIds = new Set(songs.map((song) => song.id));
    songs.push(...nextSongs.filter((song) => !knownIds.has(song.id)));
    songPage = nextPage;
    songsHaveMore = response.headers.get("X-Has-More") === "true";
    render();
  } catch (error) {
    console.error(error);
    updateSongLoadStatus("Could not load more songs. Scroll away and try again.");
  } finally {
    songsPageLoading = false;
    updateSongLoadStatus();
  }
}

const songLoadObserver = new IntersectionObserver(
  (entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadNextSongPage();
  },
  { rootMargin: "600px 0px" },
);
const songLoadSentinel = $("#songLoadSentinel");
if (songLoadSentinel) songLoadObserver.observe(songLoadSentinel);
$("#createCategory").onclick = () => {
  if (!user) return showAuth(true);
  if (!user.canCreateCategories) return showPremium();
  if (
    user.adminMode !== "master" &&
    categories.filter((category) => category.ownerId === user.id).length >= 5
  ) {
    return alert("You have reached your limit of 5 custom categories!");
  }
  $("#createCategoryForm").reset();
  $("#newCategoryCoverName").textContent = "Choose image";
  $("#createCategoryMessage").textContent = "";
  $("#createCategoryModal").hidden = false;
  $("#newCategoryName").focus();
};
$("#newCategoryCover").onchange = (event) => {
  $("#newCategoryCoverName").textContent =
    event.target.files[0]?.name || "Choose image";
};
$("#createCategoryForm").onsubmit = async (event) => {
  event.preventDefault();
  const name = cleanText($("#newCategoryName").value, 50);
  if (!name) return;
  const cover = $("#newCategoryCover").files[0];
  if (cover && !/\.(?:jpe?g|png)$/i.test(cover.name))
    return ($("#createCategoryMessage").textContent =
      "Choose a JPG or PNG category cover.");
  if (cover?.size > 2 * 1024 * 1024)
    return ($("#createCategoryMessage").textContent =
      "The category cover must be 2 MB or smaller.");
  const body = new FormData();
  body.append("name", name);
  if (cover) body.append("categoryCover", cover);
  $("#createCategoryMessage").textContent = "Creating…";
  const response = await apiFetch("/api/categories", {
    method: "POST",
    body,
  });
  if (response.ok) {
    categories.push(await response.json());
    hideModals();
    render();
  } else {
    const data = await response.json().catch(() => ({}));
    if (data.code === "CATEGORY_LIMIT")
      return alert("You have reached your limit of 5 custom categories!");
    $("#createCategoryMessage").textContent =
      data.error || "The category could not be created.";
  }
};
$("#query").oninput = (e) => {
  view("search");
  rows(
    $("#results"),
    songs.filter((s) =>
      s.title.toLowerCase().includes(e.target.value.toLowerCase()),
    ),
  );
};
$("#file").onchange = (e) =>
  ($("#title").value = e.target.files[0]?.name.replace(/\.[^.]+$/, "") || "");
$("#cover").onchange = (event) => {
  $("#coverName").textContent =
    event.target.files[0]?.name || "Choose cover image · maximum 2 MB";
};
$("#form").onsubmit = async (e) => {
  e.preventDefault();
  if (!user) return showAuth(true);
  if (e.currentTarget.dataset.capacityLocked === "true") {
    renderFreeUploadCapacity();
    return;
  }
  if (user.banned)
    return ($("#message").textContent =
      "This account cannot upload new music.");
  const audioFile = $("#file").files[0];
  const coverFile = $("#cover").files[0];
  if (!audioFile) return ($("#message").textContent = "Choose an audio file.");
  if (audioFile.size > 15 * 1024 * 1024)
    return ($("#message").textContent = "The song must be 15 MB or smaller.");
  if (coverFile?.size > 2 * 1024 * 1024)
    return ($("#message").textContent =
      "The cover image must be 2 MB or smaller.");
  $("#title").value = cleanText($("#title").value, 120);
  $("#message").textContent = "Saving…";
  let r = await apiFetch("/api/songs", {
      method: "POST",
      body: new FormData(e.target),
    }),
    d = await r.json();
  if (!r.ok) {
    $("#message").textContent = d.error || "The upload could not be saved.";
    if (
      d.code === "FREE_PENDING_QUEUE_FULL" ||
      d.code === "FREE_APPROVED_CAPACITY_FULL"
    ) {
      const profileResponse = await apiFetch("/api/auth/me", {
        cache: "no-store",
      });
      if (profileResponse.ok) Object.assign(user, await profileResponse.json());
      renderFreeUploadCapacity();
    }
    return;
  }
  if (d.uploadCapacity) Object.assign(user, d.uploadCapacity);
  $("#message").textContent = d.pendingReview
    ? "Submitted for Master Admin approval."
    : "Saved and ready to play.";
  e.target.reset();
  $("#coverName").textContent = "Choose cover image · maximum 2 MB";
  await load();
};
function updatePlayButton() {
  $("#play").textContent = audio.paused ? "▶" : "Ⅱ";
  $("#play").setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  updateInlinePlayButtons();
}
$("#play").onclick = () => {
  if (!audio.paused) {
    audio.pause();
    return;
  }
  const song = active();
  if (!song) return;
  if (!user && !guestPreviewActive) {
    const currentScope = queue
      .map((id) => songs.find((item) => item.id === id))
      .filter(Boolean);
    play(song, currentScope.length ? currentScope : songs, queueScope);
    return;
  }
  audio.play();
};
audio.addEventListener("play", () => {
  updatePlayButton();
  updateMediaSessionMetadata(active());
  updateMediaSessionPlaybackState();
});
audio.addEventListener("pause", () => {
  updatePlayButton();
  updateMediaSessionPlaybackState();
});
audio.addEventListener("ended", updatePlayButton);
audio.addEventListener("ended", () => {
  if (!user) {
    guestPreviewActive = false;
    if (guestListenCount >= 5) showAccountGate();
    return;
  }
  if (user && !user.premium && user.listenCount >= user.freeListenLimit) {
    showPremium(true);
    return;
  }
  step(1, { immediateBackgroundTransition: true });
});
$("#playerLike").onclick = () => active() && like(active());
$("#shuffle").onclick = () => {
  shuffleOn = !shuffleOn;
  $("#shuffle").classList.toggle("shuffle-on", shuffleOn);
  $("#shuffle").setAttribute("aria-pressed", String(shuffleOn));
  if (currentId) fillNextUp([]);
};
function step(n, options = {}) {
  const activeScope = queueScope;
  const available = queueSongs();
  if (!available.length) return;
  if (n > 0 && nextUpIds.length) {
    const scheduled = queueSongById(nextUpIds[0]);
    if (scheduled) {
      const nextScope = available.some((song) => song.id === scheduled.id)
        ? available
        : [...available, scheduled];
      return play(scheduled, nextScope, activeScope, nextUpIds.slice(1), options);
    }
  }
  if (shuffleOn) {
    const choices = available.filter((song) => song.id !== currentId);
    if (!choices.length) return;
    const randomNext = choices[Math.floor(Math.random() * choices.length)];
    return play(randomNext, available, activeScope, null, options);
  }
  let index = available.findIndex((song) => song.id === currentId);
  if (index < 0) index = n > 0 ? -1 : 0;
  const nextIndex = (index + n + available.length) % available.length;
  return play(available[nextIndex], available, activeScope, null, options);
}
$("#prev").onclick = () => step(-1);
$("#next").onclick = () => step(1);
const HOME_HERO_DISMISSED_KEY = "d50_home_hero_dismissed";
const homeHero = $("#homeHero");

function dismissHomeHero() {
  localStorage.setItem(HOME_HERO_DISMISSED_KEY, "true");
  homeHero.classList.add("hero-dismissed");
  homeHero.setAttribute("aria-hidden", "true");
}

if (localStorage.getItem(HOME_HERO_DISMISSED_KEY) === "true")
  dismissHomeHero();

$("#start").onclick = () => {
  dismissHomeHero();
  if (songs[0]) play(songs[0]);
};

function configureMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const actions = {
    play: () => {
      const song = active();
      if (!song) return;
      updateMediaSessionMetadata(song);
      const playback = audio.play();
      if (playback?.catch) playback.catch(() => {});
    },
    pause: () => audio.pause(),
    nexttrack: () => step(1, { immediateBackgroundTransition: true }),
    previoustrack: () => step(-1, { immediateBackgroundTransition: true }),
  };
  Object.entries(actions).forEach(([action, handler]) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (error) {
      console.debug(`Media Session action ${action} is unavailable.`, error);
    }
  });
}
configureMediaSession();

let progressAnimationFrame = 0;
function syncProgress() {
  if (!user && guestPreviewActive && audio.currentTime >= 10) {
    guestPreviewActive = false;
    audio.pause();
    if (Number.isFinite(audio.duration))
      audio.currentTime = Math.min(10, audio.duration);
    if (guestListenCount >= 5) showAccountGate();
  }
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  $("#seek").max = String(duration || 0);
  $("#seek").value = String(duration ? audio.currentTime : 0);
  $("#timer").textContent =
    fmt(audio.currentTime) + " / " + fmt(audio.duration);
}
function startProgressAnimation() {
  cancelAnimationFrame(progressAnimationFrame);
  const tick = () => {
    syncProgress();
    if (!audio.paused && !audio.ended)
      progressAnimationFrame = requestAnimationFrame(tick);
  };
  tick();
}
audio.addEventListener("play", startProgressAnimation);
audio.addEventListener("pause", () => {
  cancelAnimationFrame(progressAnimationFrame);
  syncProgress();
});
audio.addEventListener("ended", () => {
  cancelAnimationFrame(progressAnimationFrame);
  syncProgress();
});
audio.addEventListener("loadedmetadata", syncProgress);
audio.addEventListener("durationchange", syncProgress);
audio.addEventListener("timeupdate", syncProgress);
$("#seek").oninput = (event) => {
  if (Number.isFinite(audio.duration))
    audio.currentTime = Number(event.target.value);
  syncProgress();
};
$("#volume").oninput = (e) => (audio.volume = e.target.value / 100);
audio.volume = 0.68;

function showPremium(blocking = false) {
  $("#premiumModal").classList.toggle("blocking", blocking);
  $("#premiumModal").hidden = false;
}

let groupSubscriptionState = null;

async function copyGroupToken(token, button) {
  try {
    await navigator.clipboard.writeText(token);
  } catch {
    const helper = document.createElement("textarea");
    helper.value = token;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }
  const originalText = button.textContent;
  button.textContent = "Copied!";
  button.classList.add("text-cyan-200");
  window.setTimeout(() => {
    button.textContent = originalText;
    button.classList.remove("text-cyan-200");
  }, 1400);
}

function renderGroupSubscription(state) {
  groupSubscriptionState = state;
  $("#groupMemberCount").textContent = `${state.activeMemberCount} of ${state.totalSlots} slots`;
  const memberList = $("#groupMemberList");
  memberList.replaceChildren();
  [state.owner, ...state.members].forEach((member, index) => {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.035] p-4";
    const details = document.createElement("div");
    details.className = "min-w-0";
    const label = document.createElement("p");
    label.className = "m-0 text-xs text-slate-500";
    label.textContent = `Slot ${index + 1}`;
    const email = document.createElement("p");
    email.className = "mt-1 truncate font-medium text-slate-100";
    email.textContent = member.email;
    details.append(label, email);
    row.append(details);
    if (member.owner) {
      const ownerBadge = document.createElement("span");
      ownerBadge.className = "shrink-0 rounded-full bg-amber-400/10 px-3 py-1 text-xs font-semibold text-amber-200";
      ownerBadge.textContent = "👑 Owner";
      row.append(ownerBadge);
    } else if (state.canManage) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "shrink-0 rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-400/20";
      remove.textContent = "Remove";
      remove.onclick = () => removeGroupMember(member.id, remove);
      row.append(remove);
    }
    memberList.append(row);
  });

  const tokens = state.unusedTokens || [];
  const list = $("#groupTokenList");
  list.replaceChildren();
  if (!tokens.length) {
    const empty = document.createElement("div");
    empty.className = "rounded-2xl border border-dashed border-white/10 bg-white/[0.025] p-4 text-sm text-slate-400";
    empty.textContent = state.canManage
      ? "No paid invitation slots are available. Buy an extra slot to generate one code."
      : "No invitation code is available on this account.";
    list.append(empty);
  }
  tokens.forEach((token, index) => {
    const row = document.createElement("div");
    row.className =
      "flex flex-col gap-3 rounded-2xl border border-dashed border-cyan-300/20 bg-cyan-300/[0.035] p-4 sm:flex-row sm:items-center sm:justify-between";

    const details = document.createElement("div");
    details.className = "min-w-0";
    const label = document.createElement("p");
    label.className = "m-0 text-xs text-slate-500";
    label.textContent = `Paid empty slot ${state.activeMemberCount + index + 1}`;
    const code = document.createElement("code");
    code.className = "mt-1 block font-mono text-base font-bold tracking-[0.14em] text-cyan-100";
    code.textContent = token.code;
    details.append(label, code);

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className =
      "shrink-0 rounded-xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-2.5 text-xs font-bold text-cyan-100 transition hover:bg-cyan-300/20";
    copyButton.textContent = "Copy Code";
    copyButton.onclick = () => copyGroupToken(token.code, copyButton);
    row.append(details, copyButton);
    list.append(row);
  });
}

async function openGroupSubscription() {
  if (!user) return showAccountGate();
  $("#groupTokenMessage").textContent = "";
  $("#groupSubscriptionModal").hidden = false;
  $("#closeGroupSubscription").focus();
  $("#groupMemberList").innerHTML = '<p class="text-sm text-slate-400">Loading paid slots…</p>';
  $("#groupTokenList").replaceChildren();
  const response = await apiFetch("/api/subscription/group");
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    $("#groupTokenMessage").textContent =
      result.error || "Your subscription could not be loaded.";
    return;
  }
  renderGroupSubscription(result);
}

function closeGroupSubscription() {
  $("#groupSubscriptionModal").hidden = true;
}

$("#manageGroupSubscription").onclick = openGroupSubscription;
$("#mobileGroupSubscription").onclick = openGroupSubscription;
$("#closeGroupSubscription").onclick = closeGroupSubscription;
$("#groupSubscriptionModal").onclick = (event) => {
  if (event.target === $("#groupSubscriptionModal")) closeGroupSubscription();
};
async function removeGroupMember(memberId, button) {
  button.disabled = true;
  const response = await apiFetch(`/api/subscription/family-members/${encodeURIComponent(memberId)}`, {
    method: "DELETE",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    button.disabled = false;
    $("#groupTokenMessage").textContent = result.error || "The member could not be removed.";
    return;
  }
  renderGroupSubscription(result);
  $("#groupTokenMessage").textContent =
    "The member was removed. Your paid slot is available again with the same code.";
}
$("#redeemGroupTokenForm").onsubmit = async (event) => {
  event.preventDefault();
  const input = $("#groupTokenInput");
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  const enteredCode = input.value.trim();
  if (!enteredCode) return;
  submit.disabled = true;
  $("#groupTokenMessage").className =
    "mb-0 mt-3 min-h-5 text-sm text-slate-400";
  $("#groupTokenMessage").textContent = "Checking code…";
  try {
    const response = await apiFetch("/api/subscription/redeem-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: enteredCode }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      $("#groupTokenMessage").textContent =
        result.error || "That code could not be activated.";
      $("#groupTokenMessage").className =
        "mb-0 mt-3 min-h-5 text-sm text-rose-300";
      return;
    }
    user = result.user;
    input.value = "";
    $("#groupTokenMessage").textContent =
      result.type === "premium"
        ? `Premium activated for ${result.durationDays} days.`
        : "Family invitation accepted. Premium access is active.";
    $("#groupTokenMessage").className =
      "mb-0 mt-3 min-h-5 text-sm text-emerald-300";
    updateProfile();
    const groupResponse = await apiFetch("/api/subscription/group");
    if (groupResponse.ok) renderGroupSubscription(await groupResponse.json());
  } catch {
    $("#groupTokenMessage").textContent =
      "The code could not be activated. Please try again.";
    $("#groupTokenMessage").className =
      "mb-0 mt-3 min-h-5 text-sm text-rose-300";
  } finally {
    submit.disabled = false;
  }
};
function maybeShowUploadWarning() {
  if (!user || user.adminMode || user.hasSeenUploadWarning) return;
  $("#uploadWarningText").textContent = user.paid
    ? "Notice: You confirm that any music you upload is entirely yours and you have full permission to distribute it. Uploading unauthorized content, using offensive or bad names on songs/categories, or using inappropriate image covers will result in a permanent feature ban from uploading and category visibility."
    : "Notice: You confirm that any music you upload is entirely yours and you have full permission to distribute it. Uploading unauthorized or copyrighted material will result in a permanent ban from uploading songs.";
  $("#uploadWarningMessage").textContent = "";
  document.body.classList.add("upload-warning-active");
  $("#uploadWarningModal").hidden = false;
  $("#confirmUploadWarning").focus();
}
$("#confirmUploadWarning").onclick = async () => {
  const button = $("#confirmUploadWarning");
  button.disabled = true;
  $("#uploadWarningMessage").textContent = "Saving your confirmation…";
  try {
    const response = await apiFetch("/api/auth/upload-warning/acknowledge", {
      method: "POST",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      $("#uploadWarningMessage").textContent =
        data.error || "Your confirmation could not be saved.";
      return;
    }
    user = data;
    $("#uploadWarningModal").hidden = true;
    document.body.classList.remove("upload-warning-active");
    updateProfile();
  } catch {
    $("#uploadWarningMessage").textContent =
      "Your confirmation could not be saved. Please try again.";
  } finally {
    button.disabled = false;
  }
};
function hideModals() {
  $$(".modal").forEach((modal) => {
    if (modal.id === "uploadWarningModal" && !user?.hasSeenUploadWarning) return;
    modal.hidden = true;
  });
  const previewAudio = $("#pendingPreviewAudio");
  if (previewAudio) previewAudio.pause();
  pendingPreviewId = null;
  if ($("#adminHubModal")) purgeAdminUi();
}
function showAccountGate() {
  audio.pause();
  signupMode = false;
  $("#authTitle").textContent = "Continue with D50";
  $("#authSubtitle").textContent =
    "Log in or create a free account to unlock five full songs.";
  $("#authSubmit").textContent = "Log in";
  $("#authSwitch").textContent = "New to D50? Create a free account";
  $("#authMessage").textContent = "";
  showAuth(false);
}
let logoClicks = [];
let adminLockCountdownTimer = null;
function formatAdminLockTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return String(minutes).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
}
function stopAdminLockCountdown() {
  if (adminLockCountdownTimer) clearInterval(adminLockCountdownTimer);
  adminLockCountdownTimer = null;
}
function showAdminLockCountdown(lockedUntil) {
  stopAdminLockCountdown();
  const update = () => {
    const remaining = Number(lockedUntil || 0) - Date.now();
    if (remaining <= 0) {
      stopAdminLockCountdown();
      if (user) user.adminLockedUntil = null;
      $("#adminPinTitle").textContent = "Admin access";
      $("#adminPinIntro").textContent =
        "The 15-minute freeze has ended. You may enter an Admin code again.";
      $("#adminPinForm").hidden = false;
      $("#adminPinMessage").textContent = "";
      return;
    }
    $("#adminPinMessage").textContent =
      "Try again in " + formatAdminLockTime(remaining) + ".";
  };
  $("#adminPinTitle").textContent = "Admin access frozen";
  $("#adminPinIntro").textContent =
    "Three failed attempts locked Admin code entry for 15 minutes.";
  $("#adminPinForm").hidden = true;
  $("#adminPinModal").hidden = false;
  update();
  adminLockCountdownTimer = setInterval(update, 1000);
}
$("#mainLogo").onclick = () => {
  const now = Date.now();
  logoClicks = logoClicks.filter((clickedAt) => now - clickedAt <= 3000);
  logoClicks.push(now);
  if (logoClicks.length !== 5) return;
  logoClicks = [];
  if (!user || !/@gmail\.com$/i.test(String(user.email || ""))) {
    alert("Access Denied: You must be logged in to access this feature.");
    return;
  }
  if (user.isAdminBanned) {
    alert("Admin access is permanently blocked for this account.");
    return;
  }
  if (Number(user.adminLockedUntil || 0) > Date.now()) {
    showAdminLockCountdown(user.adminLockedUntil);
    return;
  }
  stopAdminLockCountdown();
  $("#adminPinTitle").textContent = "Admin access";
  $("#adminPinIntro").textContent =
    "Enter your Admin PIN to unlock its assigned access mode.";
  $("#adminPinForm").hidden = false;
  $("#adminPinForm").reset();
  $("#adminPinMessage").textContent = "";
  $("#adminPinModal").hidden = false;
  $("#adminPin").focus();
};
$("#adminPinForm").onsubmit = async (event) => {
  event.preventDefault();
  if (!user) {
    $("#adminPinMessage").textContent =
      "Log in with a free account before unlocking Admin Mode.";
    return;
  }
  $("#adminPinMessage").textContent = "Checking…";
  const response = await apiFetch("/api/admin/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: $("#adminPin").value }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.failedAttempts != null)
      user.adminFailedAttempts = Number(data.failedAttempts || 0);
    if (data.code === "ADMIN_ACCESS_FROZEN" && data.lockedUntil) {
      user.adminLockedUntil = Number(data.lockedUntil);
      showAdminLockCountdown(user.adminLockedUntil);
      return;
    }
    if (data.code === "ADMIN_ACCESS_BANNED") {
      user.isAdminBanned = true;
      user.adminLockedUntil = null;
      $("#adminPinModal").hidden = true;
      alert(data.error || "Admin access is permanently blocked for this account.");
      updateProfile();
      return;
    }
    $("#adminPinMessage").textContent =
      data.error || "Admin Mode could not be unlocked.";
    return;
  }
  user = data;
  hideModals();
  if (user.adminMode === "master" && !(await ensureAdminUi())) return;
  updateProfile();
  await load();
};
function renderAdminReports(reports) {
  const activePanel = $("#activeReportsPanel");
  const savedPanel = $("#savedReportsPanel");
  activePanel.innerHTML = "";
  savedPanel.innerHTML = "";
  const appendReports = (items, panel, emptyMessage) => {
    if (!items.length) {
      panel.innerHTML = `<p class="admin-hub-empty">${emptyMessage}</p>`;
      return;
    }
    items.forEach((report) => {
      const item = document.createElement("article");
      item.className = "admin-hub-item";
      const heading = document.createElement("b");
      heading.textContent = `${report.itemType === "category" ? "Category" : "Song"}: ${report.itemName || "Unknown item"}`;
      const message = document.createElement("p");
      message.textContent = `Why: ${report.reason || report.message || "No reason provided"}`;
      const accountLinks = document.createElement("div");
      accountLinks.className = "report-account-links";
      const accountShortcut = (label, id, email, className) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `report-account-link ${className}`;
        button.textContent = `${label}: ${email || "Unknown account"}`;
        button.disabled = !id;
        button.title = id
          ? `Open ${email || "this account"} in the Manager hub`
          : "This account is no longer available";
        button.onclick = () => openManagerForAccount(id, email);
        return button;
      };
      accountLinks.append(
        accountShortcut(
          "Reporter",
          report.reporterId,
          report.reporterEmail,
          "reporter-account-link",
        ),
        accountShortcut(
          "Content owner",
          report.reportedUserId,
          report.reportedUserEmail,
          "owner-account-link",
        ),
      );
      const meta = document.createElement("small");
      meta.className = "report-timestamp";
      meta.textContent = new Date(report.createdAt).toLocaleString();
      const actions = document.createElement("div");
      actions.className = "admin-report-actions";
      const remember = document.createElement("button");
      remember.type = "button";
      remember.textContent = report.remembered ? "★ Saved" : "☆ Remember";
      remember.onclick = async () => {
        const response = await apiFetch(`/api/reports/${report.id}/remember`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ remembered: !report.remembered }),
        });
        if (!response.ok) return handleLocked(response);
        await loadAdminHub();
      };
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "dismiss-report";
      dismiss.textContent = "🗑 Dismiss";
      dismiss.onclick = async () => {
        if (!confirm("Permanently dismiss this report?")) return;
        const response = await apiFetch(`/api/reports/${report.id}`, {
          method: "DELETE",
        });
        if (!response.ok) return handleLocked(response);
        await loadAdminHub();
      };
      actions.append(remember, dismiss);
      item.append(heading, message, accountLinks, meta, actions);
      panel.append(item);
    });
  };
  appendReports(
    reports.filter((report) => !report.remembered),
    activePanel,
    "No active reports.",
  );
  appendReports(
    reports.filter((report) => report.remembered),
    savedPanel,
    "No saved reports yet.",
  );
}
function renderBannedUsers(bannedUsers) {
  const panel = $("#bansPanel");
  panel.innerHTML = "";
  if (!bannedUsers.length) {
    panel.innerHTML = '<p class="admin-hub-empty">No banned users.</p>';
    return;
  }
  bannedUsers.forEach((bannedUser) => {
    const item = document.createElement("article");
    item.className = "admin-hub-item banned-user-item";
    const details = document.createElement("span");
    const email = document.createElement("b");
    email.textContent = bannedUser.email;
    const reference = document.createElement("small");
    reference.className = "ban-reference";
    reference.textContent = bannedUser.banReference || "Banned account";
    const reason = document.createElement("small");
    reason.textContent = `Reason: ${bannedUser.banReason || "No reason recorded"}`;
    const timestamp = document.createElement("small");
    timestamp.textContent = bannedUser.bannedAt
      ? `Banned: ${new Date(bannedUser.bannedAt).toLocaleString()}`
      : "Ban time unavailable";
    details.append(email, reference, reason, timestamp);
    const unban = document.createElement("button");
    unban.type = "button";
    unban.textContent = "Unban";
    unban.onclick = async () => {
      if (!confirm(`Unban ${bannedUser.email}?`)) return;
      const response = await apiFetch(
        `/api/admin/users/${bannedUser.id}/unban`,
        { method: "POST" },
      );
      if (!response.ok) return handleLocked(response);
      await loadAdminHub();
    };
    item.append(details, unban);
    panel.append(item);
  });
}
function renderAdminBlockedUsers(blockedUsers) {
  const panel = $("#adminBlockedPanel");
  panel.innerHTML = "";
  if (!blockedUsers.length) {
    panel.innerHTML =
      '<p class="admin-hub-empty">No accounts are blocked from Admin access.</p>';
    return;
  }
  blockedUsers.forEach((blockedUser) => {
    const item = document.createElement("article");
    item.className = "admin-hub-item admin-access-block-item";
    const details = document.createElement("span");
    const email = document.createElement("b");
    email.textContent = blockedUser.email;
    const strikes = document.createElement("small");
    strikes.textContent =
      "Failed Admin codes: " + Number(blockedUser.failedAttempts || 0) + "/6";
    const status = document.createElement("small");
    status.className = blockedUser.isAdminBanned
      ? "admin-block-permanent"
      : "admin-block-temporary";
    status.textContent = blockedUser.isAdminBanned
      ? "Permanently banned from Admin access"
      : "Frozen until " + new Date(blockedUser.adminLockedUntil).toLocaleString();
    details.append(email, strikes, status);
    item.append(details);
    panel.append(item);
  });
}
function renderAdminAccessCodes(codes) {
  const panel = $("#adminCodesPanel");
  panel.innerHTML = "";
  if (!codes.length) {
    panel.innerHTML = '<p class="admin-hub-empty">No invite codes created yet.</p>';
    return;
  }
  codes.forEach((entry) => {
    const row = document.createElement("article");
    row.className = "admin-code-row";
    const code = document.createElement("b");
    code.className = "admin-code-value";
    code.textContent = entry.code;
    const status = document.createElement("span");
    status.className = `admin-code-status ${entry.status === "redeemed" ? "redeemed" : "active"}`;
    status.textContent =
      entry.status === "redeemed"
        ? `Redeemed by ${entry.redeemedByEmail || "unknown user"}`
        : "Active";
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "revoke-admin-code";
    revoke.textContent = "🗑️ Revoke Code";
    revoke.onclick = async () => {
      if (!confirm(`Revoke invite code “${entry.code}”?`)) return;
      revoke.disabled = true;
      const response = await apiFetch(`/api/admin/access-codes/${entry.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        revoke.disabled = false;
        return handleLocked(response);
      }
      await loadAdminHub();
    };
    row.append(code, status, revoke);
    panel.append(row);
  });
}
async function handleAdminCodeSubmit(event) {
  event.preventDefault();
  if (user?.adminMode !== "master") return;
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  $("#adminCodeMessage").textContent = "Creating invite code…";
  try {
    const response = await apiFetch("/api/admin/access-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: $("#adminCodeInput").value }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      $("#adminCodeMessage").textContent =
        result.error || "The invite code could not be created.";
      return;
    }
    event.currentTarget.reset();
    $("#adminCodeMessage").textContent = "Invite code created.";
    await loadAdminHub();
  } finally {
    submit.disabled = false;
  }
}

function renderPremiumCodes(codes) {
  const panel = $("#premiumCodesPanel");
  panel.replaceChildren();
  if (!codes.length) {
    panel.innerHTML =
      '<p class="admin-hub-empty">No Premium codes created yet.</p>';
    return;
  }
  codes.forEach((entry) => {
    const row = document.createElement("article");
    row.className = "admin-code-row premium-code-row";
    const code = document.createElement("b");
    code.className = "admin-code-value";
    code.textContent = entry.code;
    const duration = document.createElement("span");
    duration.className = "premium-code-duration";
    duration.textContent = `${Number(entry.durationDays)} days`;
    const status = document.createElement("span");
    status.className = `admin-code-status ${entry.isUsed ? "redeemed" : "active"}`;
    status.textContent = entry.isUsed
      ? `Redeemed by ${entry.claimedBy || "unknown user"}`
      : "Unused";
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "revoke-admin-code";
    revoke.textContent = "Revoke Code";
    revoke.onclick = async () => {
      if (!confirm(`Revoke Premium code “${entry.code}”?`)) return;
      revoke.disabled = true;
      const response = await apiFetch(`/api/admin/premium-codes/${entry.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        revoke.disabled = false;
        return handleLocked(response);
      }
      await loadAdminHub();
    };
    row.append(code, duration, status, revoke);
    panel.append(row);
  });
}

async function handlePremiumCodeSubmit(event) {
  event.preventDefault();
  if (user?.adminMode !== "master") return;
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  $("#premiumCodeMessage").textContent = "Creating Premium code…";
  try {
    const response = await apiFetch("/api/admin/create-premium-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: $("#premiumCodeInput").value,
        durationDays: Number($("#premiumCodeDuration").value),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      $("#premiumCodeMessage").textContent =
        result.error || "The Premium code could not be created.";
      return;
    }
    event.currentTarget.reset();
    $("#premiumCodeDuration").value = "30";
    $("#premiumCodeMessage").textContent = "Premium code created.";
    await loadAdminHub();
  } finally {
    submit.disabled = false;
  }
}
async function handleBanAccountSubmit(event) {
  event.preventDefault();
  if (user?.adminMode !== "master") return;
  const submit = event.currentTarget.querySelector('button[type="submit"], button:not([type])');
  submit.disabled = true;
  $("#banAccountMessage").textContent = "Saving ban…";
  try {
    const response = await apiFetch("/api/admin/users/ban", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: banAccountTarget?.id || "",
        email: banAccountTarget?.email || $("#banAccountEmail").value,
        banReference: $("#banAccountReference").value,
        banReason: $("#banAccountReason").value,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      $("#banAccountMessage").textContent = result.error || "The account could not be banned.";
      return;
    }
    const filteredAccountWasBanned =
      managerAccountFilter?.id && managerAccountFilter.id === result.id;
    $("#banAccountModal").hidden = true;
    banAccountTarget = null;
    if (filteredAccountWasBanned) {
      managerAccountFilter.banned = true;
      managerAccountFilter.banReference = result.banReference;
      managerAccountFilter.banReason = result.banReason;
      renderManagerAccountFilter();
      await load();
    } else if (!$("#adminHubModal").hidden) await loadAdminHub();
    else {
      $("#adminHubModal").hidden = false;
      await loadAdminHub();
    }
  } finally {
    submit.disabled = false;
  }
}
async function loadAdminHub() {
  if (user?.adminMode !== "master") return;
  $("#adminHubMessage").textContent = "Loading…";
  const [reportsResponse, bansResponse, codesResponse, premiumCodesResponse] = await Promise.all([
    apiFetch("/api/reports", { cache: "no-store" }),
    apiFetch("/api/admin/reports-bans", { cache: "no-store" }),
    apiFetch("/api/admin/access-codes", { cache: "no-store" }),
    apiFetch("/api/admin/premium-codes", { cache: "no-store" }),
  ]);
  const [reports, bansData, codes, premiumCodes] = await Promise.all([
    reportsResponse.json().catch(() => []),
    bansResponse.json().catch(() => ({})),
    codesResponse.json().catch(() => []),
    premiumCodesResponse.json().catch(() => []),
  ]);
  if (user?.adminMode !== "master" || !$("#adminHubModal")) return;
  if (
    !reportsResponse.ok ||
    !bansResponse.ok ||
    !codesResponse.ok ||
    !premiumCodesResponse.ok
  ) {
    $("#adminHubMessage").textContent =
      bansData.error || "Admin data could not be loaded.";
    return;
  }
  renderAdminReports(Array.isArray(reports) ? reports : []);
  renderBannedUsers(bansData.bannedUsers || []);
  renderAdminBlockedUsers(bansData.adminBlockedUsers || []);
  renderAdminAccessCodes(Array.isArray(codes) ? codes : []);
  renderPremiumCodes(Array.isArray(premiumCodes) ? premiumCodes : []);
  if (managerAccountFilter?.id) {
    const selectedBan = (bansData.bannedUsers || []).find(
      (account) => account.id === managerAccountFilter.id,
    );
    managerAccountFilter.banned = Boolean(selectedBan);
    managerAccountFilter.banReference = selectedBan?.banReference || null;
    managerAccountFilter.banReason = selectedBan?.banReason || null;
    managerAccountFilter.checkingBanStatus = false;
    renderManagerAccountFilter();
  }
  $("#adminHubMessage").textContent = "";
}
$("#adminHubButton").onclick = async () => {
  if (user?.adminMode !== "master") return;
  if (!(await ensureAdminUi())) return;
  $("#adminHubModal").hidden = false;
  await loadAdminHub();
};
function updateFreeUploadsCount() {
  $("#freeUploadsCount").textContent = String(pendingUploads.length);
}
function pendingTrackDuration(url) {
  if (!url) return Promise.resolve(null);
  if (pendingDurationCache.has(url)) return pendingDurationCache.get(url);
  const durationPromise = new Promise((resolve) => {
    const probe = new Audio();
    let finished = false;
    const finish = (duration = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      probe.removeAttribute("src");
      probe.load();
      resolve(Number.isFinite(duration) && duration >= 0 ? duration : null);
    };
    const timeout = setTimeout(() => finish(), 12000);
    probe.preload = "metadata";
    probe.addEventListener("loadedmetadata", () => finish(probe.duration), {
      once: true,
    });
    probe.addEventListener("error", () => finish(), { once: true });
    probe.src = url;
  });
  pendingDurationCache.set(url, durationPromise);
  return durationPromise;
}
function renderPendingUploads() {
  const list = $("#freeUploadsList");
  if (!list) return;
  list.innerHTML = "";
  if (!pendingUploads.length) {
    const empty = document.createElement("p");
    empty.className = "free-uploads-empty";
    empty.textContent = "No free uploads are waiting for approval.";
    list.append(empty);
    return;
  }
  pendingUploads.forEach((track) => {
    const row = document.createElement("article");
    row.className = "free-upload-row";
    const artwork = document.createElement("div");
    artwork.className = "free-upload-artwork";
    if (track.coverUrl) {
      const image = document.createElement("img");
      image.src = track.coverUrl;
      image.alt = "";
      artwork.append(image);
    } else {
      artwork.textContent = "◎";
    }
    const details = document.createElement("div");
    details.className = "free-upload-details";
    const titleLine = document.createElement("div");
    titleLine.className = "free-upload-title-line";
    const title = document.createElement("b");
    title.textContent = track.title || "Untitled track";
    const duration = document.createElement("span");
    duration.className = "free-upload-duration";
    duration.textContent = "–:––";
    duration.setAttribute("aria-label", "Loading track duration");
    titleLine.append(title, duration);
    pendingTrackDuration(track.url).then((seconds) => {
      if (!duration.isConnected) return;
      duration.textContent = seconds === null ? "–:––" : fmt(seconds);
      duration.setAttribute(
        "aria-label",
        seconds === null ? "Track duration unavailable" : `Duration ${fmt(seconds)}`,
      );
    });
    const accountLine = document.createElement("div");
    accountLine.className = "free-upload-account-line";
    const email = document.createElement("span");
    email.textContent = track.ownerEmail || "Unknown free account";
    const accountBadge = document.createElement("button");
    accountBadge.type = "button";
    accountBadge.className = "pending-account-badge";
    accountBadge.textContent = "A";
    accountBadge.title = `Inspect ${track.ownerEmail || "this uploader"}`;
    accountBadge.setAttribute("aria-label", accountBadge.title);
    accountBadge.disabled = !track.ownerId;
    accountBadge.onclick = () =>
      openManagerForAccount(track.ownerId, track.ownerEmail);
    accountLine.append(email, accountBadge);
    const submitted = document.createElement("small");
    submitted.textContent = `Submitted ${new Date(track.createdAt).toLocaleString()}`;
    details.append(titleLine, accountLine, submitted);
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "pending-preview-button";
    preview.textContent = pendingPreviewId === track.id ? "⏸ Stop" : "▶ Preview";
    preview.onclick = async () => {
      const previewAudio = $("#pendingPreviewAudio");
      if (pendingPreviewId === track.id && !previewAudio.paused) {
        previewAudio.pause();
        pendingPreviewId = null;
        renderPendingUploads();
        return;
      }
      previewAudio.pause();
      previewAudio.src = track.url;
      pendingPreviewId = track.id;
      renderPendingUploads();
      try {
        await previewAudio.play();
      } catch {
        pendingPreviewId = null;
        renderPendingUploads();
        $("#freeUploadsMessage").textContent = "Preview could not be played.";
      }
    };
    const actions = document.createElement("div");
    actions.className = "free-upload-actions";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "approve-upload-button";
    approve.textContent = "✔ Approve";
    approve.onclick = async () => {
      approve.disabled = true;
      $("#freeUploadsMessage").textContent = `Approving ${track.title}…`;
      const response = await apiFetch(
        `/api/admin/pending-uploads/${track.id}/approve`,
        { method: "PATCH" },
      );
      if (!response.ok) {
        approve.disabled = false;
        return handleLocked(response);
      }
      if (pendingPreviewId === track.id) $("#pendingPreviewAudio")?.pause();
      pendingPreviewId = null;
      if ($("#freeUploadsMessage"))
        $("#freeUploadsMessage").textContent = `${track.title} is now published.`;
      await Promise.all([syncPendingUploads(true), load()]);
    };
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "deny-upload-button";
    deny.textContent = "✖ Deny";
    deny.onclick = async () => {
      if (!confirm(`Deny and permanently remove ${track.title}?`)) return;
      deny.disabled = true;
      const response = await apiFetch(
        `/api/admin/pending-uploads/${track.id}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        deny.disabled = false;
        return handleLocked(response);
      }
      if (pendingPreviewId === track.id) $("#pendingPreviewAudio")?.pause();
      pendingPreviewId = null;
      if ($("#freeUploadsMessage"))
        $("#freeUploadsMessage").textContent = `${track.title} was denied.`;
      await syncPendingUploads(true);
    };
    actions.append(approve, deny);
    row.append(artwork, details, preview, actions);
    list.append(row);
  });
}
async function syncPendingUploads(renderOpenModal = false) {
  if (user?.adminMode !== "master" || pendingUploadsLoading) return;
  pendingUploadsLoading = true;
  try {
    const response = await apiFetch("/api/admin/pending-uploads", {
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = await response.json().catch(() => []);
    pendingUploads = Array.isArray(data) ? data : [];
    updateFreeUploadsCount();
    const modal = $("#freeUploadsModal");
    if (modal && (renderOpenModal || !modal.hidden))
      renderPendingUploads();
  } finally {
    pendingUploadsLoading = false;
  }
}
$("#freeUploadsButton").onclick = async () => {
  if (user?.adminMode !== "master") return;
  if (!(await ensureAdminUi())) return;
  $("#freeUploadsModal").hidden = false;
  $("#freeUploadsMessage").textContent = "Loading pending uploads…";
  await syncPendingUploads(true);
  if ($("#freeUploadsMessage")) $("#freeUploadsMessage").textContent = "";
};
function handlePendingPreviewEnded() {
  pendingPreviewId = null;
  const modal = $("#freeUploadsModal");
  if (modal && !modal.hidden) renderPendingUploads();
}
let reportModeActive = false;
let reportSelectionLocked = false;
function startReportMode() {
  if (!user?.paid || user.adminMode === "master") return;
  hideModals();
  reportModeActive = true;
  reportSelectionLocked = false;
  document.body.classList.add("report-mode-active");
  $("#reportModeBadge").hidden = false;
}
function finishReportMode() {
  reportModeActive = false;
  reportSelectionLocked = false;
  document.body.classList.remove("report-mode-active");
  const badge = $("#reportModeBadge");
  if (badge) badge.hidden = true;
  const modal = $("#reportConfirmationModal");
  if (modal) modal.hidden = true;
}
async function submitSelectedReport(target) {
  const reasonInput = prompt("Why are you reporting this content?", "");
  if (reasonInput === null) return;
  const reason = cleanText(reasonInput, 500);
  if (!reason) return alert("Please enter a reason for the report.");
  const item = {
    itemId: target.dataset.reportId,
    itemName: target.dataset.reportName,
    itemType: target.dataset.reportType,
    reason,
    reporterEmail: user?.email || "",
  };
  reportSelectionLocked = true;
  $("#reportModeBadge").firstChild.textContent = "Sending report… ";
  try {
    const response = await apiFetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      reportSelectionLocked = false;
      $("#reportModeBadge").firstChild.textContent =
        "Click on any song card, category card, or image cover to report it… ";
      if (data.code === "PAID_REQUIRED") return showPremium(true);
      return alert(data.error || "The report could not be submitted.");
    }
    $("#reportConfirmationText").textContent =
      `You reported the ${item.itemType} “${item.itemName}”. It is now visible to the Master Admin.`;
    $("#reportConfirmationModal").hidden = false;
    $("#reportConfirmationDone").focus();
  } catch {
    reportSelectionLocked = false;
    $("#reportModeBadge").firstChild.textContent =
      "Click on any song card, category card, or image cover to report it… ";
    alert("The report could not be sent. Your music will keep playing.");
  }
}
$("#reportContentButton").onclick = startReportMode;
$("#cancelReportMode").onclick = finishReportMode;
$("#reportConfirmationClose").onclick = finishReportMode;
$("#reportConfirmationDone").onclick = finishReportMode;
document.addEventListener(
  "click",
  (event) => {
    if (!reportModeActive || reportSelectionLocked) return;
    const target = event.target.closest("[data-report-id]");
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    submitSelectedReport(target);
  },
  true,
);
function finishBoostMode() {
  adminBoostMode = null;
  document.body.classList.remove("boost-mode-active", "gold", "silver");
  $("#boostModeBadge").hidden = true;
  $("#goldBoostButton").classList.remove("active");
  $("#silverBoostButton").classList.remove("active");
}
function startBoostMode(tier) {
  if (user?.adminMode !== "master") return;
  if (adminBoostMode === tier) return finishBoostMode();
  finishReportMode();
  adminBoostMode = tier;
  document.body.classList.add("boost-mode-active", tier);
  $("#boostModeBadge").hidden = false;
  $("#boostModeText").textContent =
    `Click any song or category to toggle its ${tier === "gold" ? "Gold" : "Silver"} Boost…`;
  $("#goldBoostButton").classList.toggle("active", tier === "gold");
  $("#silverBoostButton").classList.toggle("active", tier === "silver");
}
async function toggleAdminBoost(target) {
  const payload = {
    itemType: target.dataset.reportType,
    itemId: target.dataset.reportId,
    tier: adminBoostMode,
  };
  const response = await apiFetch("/api/admin/boost", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) return handleLocked(response);
  const updated = await response.json();
  const collection = payload.itemType === "song" ? songs : categories;
  const index = collection.findIndex((item) => item.id === updated.id);
  if (index >= 0) collection[index] = updated;
  render();
}
$("#goldBoostButton").onclick = () => startBoostMode("gold");
$("#silverBoostButton").onclick = () => startBoostMode("silver");
$("#cancelBoostMode").onclick = finishBoostMode;
document.addEventListener(
  "click",
  (event) => {
    if (!adminBoostMode || user?.adminMode !== "master") return;
    const target = event.target.closest("[data-report-id]");
    if (!target || event.target.closest("#adminBoostTools, #boostModeBadge"))
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleAdminBoost(target);
  },
  true,
);
async function handleLocked(response) {
  const data = await response.json().catch(() => ({}));
  if (data.code === "FREE_LIMIT") return showPremium(true);
  if (data.code === "PREMIUM_REQUIRED") return showPremium();
  if (data.code === "PAID_REQUIRED") return showPremium(true);
  if (data.code === "MANAGEMENT_REQUIRED") {
    if (user?.adminMode === "free")
      return alert("Free Admin Mode does not include management controls.");
    return showPremium();
  }
  alert(data.error || "That action could not be completed.");
}
function updateProfile() {
  if (!user) return;
  if (user.adminMode !== "master") managerAccountFilter = null;
  if (user.adminMode !== "master" && hiddenDefaultRows.size) {
    hiddenDefaultRows.clear();
    localStorage.setItem("d50_hidden_default_rows", "[]");
  }
  $("#profileEmail").textContent = user.email;
  $("#accessBadge").textContent =
    user.adminMode === "master"
      ? "◆ Master Admin"
      : user.adminMode === "free"
        ? "◇ Free Admin"
        : user.paid
          ? "✦ Premium active"
          : user.trialActive
            ? "✦ Premium trial"
            : "Free account";
  $("#trialTimer").textContent =
    user.adminMode === "master"
      ? "All controls unlocked"
      : user.adminMode === "free"
        ? "Unlimited playback and likes"
        : user.paid
          ? `Premium Days: ${Math.max(0, Number(user.premiumDaysRemaining || 0))}${user.autoRenew === false ? " (Auto-Pay Off)" : ""}`
          : user.trialActive
            ? `${user.daysLeft} day${user.daysLeft === 1 ? "" : "s"} left in trial`
            : `${Math.max(0, user.freeListenLimit - user.listenCount)} of ${user.freeListenLimit} free listens left`;
  $("#topAccess").textContent =
    user.adminMode === "master"
      ? "◆ Master Admin"
      : user.adminMode === "free"
        ? "◇ Free Admin"
        : user.paid
          ? `Premium · ${Math.max(0, Number(user.premiumDaysRemaining || 0))}d`
          : user.trialActive
            ? `✦ Trial · ${user.daysLeft}d`
            : `Free · ${Math.max(0, user.freeListenLimit - user.listenCount)}/${user.freeListenLimit}`;
  $("#uploadNavButton").hidden = false;
  $("#createCategory").hidden = !user.canCreateCategories;
  $(".upload-categories").hidden = !user.canManage;
  $("#form").hidden = Boolean(user.banned);
  $("#bannedUploadNotice").hidden = !user.banned;
  $("#freeUploadNotice").hidden = Boolean(
    user.canManage || user.banned,
  );
  renderFreeUploadCapacity();
  $("#playerLike").hidden = !user.premium;
  $("#accountAction").textContent = "Log out";
  $("#accountAction").hidden = false;
  $("#manageGroupSubscription").hidden = false;
  $("#mobileGroupSubscription").hidden = false;
  $("#headerUpgrade").hidden = user.premium;
  $("#cancelSubscriptionButton").hidden =
    !user.paid || Boolean(user.adminMode) || user.autoRenew === false;
  $("#adminHubButton").hidden = user.adminMode !== "master";
  $("#freeUploadsButton").hidden = user.adminMode !== "master";
  if (user.adminMode !== "master") {
    pendingUploads = [];
    updateFreeUploadsCount();
    purgeAdminUi();
  }
  $("#reportContentButton").hidden =
    !user.paid || user.adminMode === "master";
  $("#adminBoostTools").hidden = user.adminMode !== "master";
  if (user.adminMode === "master") finishReportMode();
  if (user.adminMode !== "master") finishBoostMode();
  $("#headerAccountIcon").classList.add("logged-in");
  $("#headerAccountIcon").setAttribute("aria-label", `Log out ${user.email}`);
  $("#headerAccountIcon").title = `Log out ${user.email}`;
  renderManagerAccountFilter();
  renderBoostMilestones();
  if (user.adminMode === "master" && $("#freeUploadsModal"))
    syncPendingUploads();
}
function renderBoostMilestones() {
  const goldTotal = Number(user?.adminFeatures || 0);
  const silverTotal = Number(user?.adminSilverFeatures || 0);
  const eligible = Boolean(user);
  $("#goldBoostTotal").textContent = goldTotal.toLocaleString();
  $("#silverBoostTotal").textContent = silverTotal.toLocaleString();
  $("#goldBoostTrophy").hidden = !eligible || goldTotal < 1;
  $("#silverBoostTrophy").hidden = !eligible || silverTotal < 1;
  $("#boostMilestones").hidden =
    !eligible || (goldTotal < 1 && silverTotal < 1);
}
function updateGuestProfile() {
  managerAccountFilter = null;
  purgeAdminUi();
  finishBoostMode();
  const remaining = Math.max(0, 5 - guestListenCount);
  if (hiddenDefaultRows.size) {
    hiddenDefaultRows.clear();
    localStorage.setItem("d50_hidden_default_rows", "[]");
  }
  $("#profileEmail").textContent = "Guest";
  $("#accessBadge").textContent = "Guest";
  $("#trialTimer").textContent = `${remaining} of 5 free listens left`;
  $("#topAccess").textContent = `Guest · ${remaining}/5 * 10sec`;
  $("#uploadNavButton").hidden = true;
  $("#form").hidden = false;
  $("#bannedUploadNotice").hidden = true;
  $("#freeUploadNotice").hidden = true;
  $("#createCategory").hidden = true;
  $(".upload-categories").hidden = true;
  $("#playerLike").hidden = true;
  $("#accountAction").hidden = true;
  $("#manageGroupSubscription").hidden = true;
  $("#mobileGroupSubscription").hidden = true;
  $("#headerUpgrade").hidden = true;
  $("#cancelSubscriptionButton").hidden = true;
  $("#adminHubButton").hidden = true;
  $("#freeUploadsButton").hidden = true;
  pendingUploads = [];
  updateFreeUploadsCount();
  $("#reportContentButton").hidden = true;
  $("#adminBoostTools").hidden = true;
  $("#boostMilestones").hidden = true;
  finishReportMode();
  $("#headerAccountIcon").classList.remove("logged-in");
  $("#headerAccountIcon").setAttribute(
    "aria-label",
    "Log in or create account",
  );
  $("#headerAccountIcon").title = "Log in or create account";
}
function showGuestApp() {
  user = null;
  document.body.classList.remove("auth-active");
  document.body.classList.add("dashboard-active");
  $("#authScreen").hidden = true;
  $("#authScreen").setAttribute("aria-hidden", "true");
  $("#authScreen").classList.remove("guest-gate");
  $("#authScreen").classList.remove("account-gate");
  view("home");
  updateGuestProfile();
  load();
}
function showApp() {
  document.body.classList.remove("auth-active");
  document.body.classList.add("dashboard-active");
  $("#authScreen").hidden = true;
  $("#authScreen").setAttribute("aria-hidden", "true");
  $("#authScreen").classList.remove("guest-gate");
  $("#authScreen").classList.remove("account-gate");
  updateProfile();
  load();
  showPendingWarning();
}
function showPendingWarning() {
  const warning = user?.warnings?.[0];
  if (!warning) return;
  $("#warningMessage").textContent =
    `An Administrator has removed your content. Reason: ${warning.message}`;
  $("#warningModal").dataset.warningId = warning.id;
  $("#warningModal").hidden = false;
  $("#warningAcknowledge").focus();
}
$("#warningAcknowledge").onclick = async () => {
  const warningId = $("#warningModal").dataset.warningId;
  const response = await apiFetch(`/api/warnings/${warningId}/acknowledge`, {
    method: "POST",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    return alert(data.error || "The warning could not be acknowledged.");
  user = data;
  $("#warningModal").hidden = true;
  showPendingWarning();
};
function showAuth(blocking = false) {
  hideModals();
  audio.pause();
  if (blocking) {
    $("#authScreen").classList.add("guest-gate");
    $("#authScreen").classList.remove("account-gate");
  } else {
    document.body.classList.remove("auth-active");
    document.body.classList.add("dashboard-active");
    $("#authScreen").classList.remove("guest-gate");
    $("#authScreen").classList.add("account-gate");
  }
  $("#authScreen").hidden = false;
  $("#authScreen").removeAttribute("aria-hidden");
}
function closeAuthGate() {
  const screen = $("#authScreen");
  if (
    !screen.classList.contains("guest-gate") &&
    !screen.classList.contains("account-gate")
  )
    return;
  screen.hidden = true;
  screen.setAttribute("aria-hidden", "true");
  screen.classList.remove("guest-gate");
  screen.classList.remove("account-gate");
  document.body.classList.remove("auth-active");
  document.body.classList.add("dashboard-active");
}
$("#authClose").onclick = closeAuthGate;
$("#authScreen").onclick = (event) => {
  if (event.target === $("#authScreen")) closeAuthGate();
};
async function restoreSavedSession() {
  if (!sessionToken) {
    showGuestApp();
    return;
  }

  try {
    const response = await apiFetch("/api/auth/me", { cache: "no-store" });
    if (response.ok) {
      user = await response.json();
      showApp();
      return;
    }

    // Only remove a saved token when the server confirms that it is invalid.
    if (response.status === 401 || response.status === 403) {
      sessionToken = "";
      localStorage.removeItem("d50_session");
    }
  } catch (error) {
    // Keep the local token during temporary network or Render wake-up errors.
    console.error("Could not restore the saved session:", error);
  }

  showGuestApp();
}
$("#authSwitch").onclick = () => {
  signupMode = !signupMode;
  $("#authTitle").textContent = signupMode
    ? "Create your free account"
    : "Welcome back";
  $("#authSubtitle").textContent = signupMode
    ? "Sign up to unlock five full-length songs."
    : "Log in to continue with your account.";
  $("#authSubmit").textContent = signupMode ? "Create free account" : "Log in";
  $("#authSwitch").textContent = signupMode
    ? "Already have an account? Log in"
    : "New to D50? Create a free account";
  $("#authMessage").textContent = "";
};
$("#authForm").onsubmit = async (event) => {
  event.preventDefault();
  $("#authMessage").textContent = "Please wait…";
  const response = await fetch(`/api/auth/${signupMode ? "signup" : "login"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: $("#authEmail").value,
      password: $("#authPassword").value,
    }),
  });
  const data = await response.json();
  if (!response.ok)
    return ($("#authMessage").textContent =
      data.error || "Could not continue.");
  sessionToken = data.token;
  localStorage.setItem("d50_session", sessionToken);
  user = data.user;
  $("#authForm").reset();
  guestPreviewActive = false;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  currentId = null;
  queue = [];
  nextUpIds = [];
  $("#now").textContent = "Choose a song";
  syncProgress();
  showApp();
};
$("#accountAction").onclick = async () => {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Local session state is still cleared below if the server is unavailable.
  } finally {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    sessionToken = "";
    localStorage.removeItem("d50_session");
    user = null;
    songs = [];
    categories = [];
    managedUploads = [];
    queue = [];
    currentId = null;
    nextUpIds = [];
    guestPreviewActive = false;
    guestListenCount = 0;
    localStorage.setItem("d50_guest_listens", "0");
    $("#now").textContent = "Choose a song";
    syncProgress();
    showGuestApp();
  }
};
$("#headerAccountIcon").onclick = () => {
  if (user) $("#accountAction").click();
  else showAccountGate();
};
$("#topAccess").onclick = () => {
  if (!user) showAccountGate();
  else if (user.paid && !user.adminMode && user.autoRenew !== false)
    openCancelSubscription();
};
function openCancelSubscription() {
  if (!user?.paid || user.adminMode || user.autoRenew === false) return;
  $("#cancelSubscriptionMessage").textContent = "";
  $("#cancelSubscriptionModal").hidden = false;
  $("#confirmCancelSubscription").focus();
}
$("#cancelSubscriptionButton").onclick = openCancelSubscription;
$("#keepPremiumButton").onclick = () => {
  $("#cancelSubscriptionModal").hidden = true;
};
$("#confirmCancelSubscription").onclick = async () => {
  const button = $("#confirmCancelSubscription");
  button.disabled = true;
  $("#cancelSubscriptionMessage").textContent = "Cancelling Premium…";
  try {
    const response = await apiFetch("/api/auth/cancel-subscription", {
      method: "POST",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      $("#cancelSubscriptionMessage").textContent =
        data.error || "Premium could not be cancelled.";
      return;
    }
    user = data;
    hideModals();
    updateProfile();
    await load();
  } finally {
    button.disabled = false;
  }
};
$("#headerUpgrade").onclick = () => showPremium(true);
$$(".modal-close").forEach(
  (button) =>
    (button.onclick =
      button.id === "reportConfirmationClose" ? finishReportMode : hideModals),
);
async function requestStripeCheckout(button, purchase) {
  if (!user) return showAccountGate();
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Opening Stripe…";
  try {
    const response = await apiFetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purchase }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.url) {
      alert(data.error || "Stripe checkout could not be opened.");
      return;
    }
    window.location.assign(data.url);
  } catch (error) {
    console.error("Stripe checkout failed:", error);
    alert("Stripe checkout could not be opened. Please try again.");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}
$("#upgradeNow").onclick = () =>
  requestStripeCheckout($("#upgradeNow"), "personal");

$("#groupBuySlots").onclick = () =>
  requestStripeCheckout($("#groupBuySlots"), "extra_slots");
setInterval(() => {
  if (user?.adminMode === "master" && !document.hidden)
    syncPendingUploads();
}, 3000);
restoreSavedSession();
