# One request queue per programme keeps playlist boundaries and prefetch in order
def radio_schedule_minute() =
  now = time.local()
  ((now.week_day + 6) mod 7) * 1440 + now.hour * 60 + now.min
end

def radio_program(~id, ~mode, ~reload, ~schedules=[], ~schedule_time=radio_schedule_minute, sources) =
  id = string.id.default(default="autodj_program", id)
  remaining_schedules = ref(schedules)
  def make_playlist(entry) =
    files = ref([])
    pending = ref([])
    windows = if remaining_schedules() == [] then [] else list.hd(remaining_schedules()) end
    if remaining_schedules() != [] then remaining_schedules := list.tl(remaining_schedules()) end
    {
      uri=entry.uri,
      weight=entry.weight,
      windows=windows,
      files={files()},
      set_files=fun (value) -> files := value,
      pending={pending()},
      set_pending=fun (value) -> pending := value
    }
  end
  playlists = list.map(make_playlist, sources)
  loaded_at = ref(-1.)
  known_keys = ref([])
  failed_until = ref([])
  last_key = ref("")
  played_key = ref("")
  current_playlist = ref(0)
  quota = ref(list.hd(playlists).weight)
  repeating = ref(false)
  unavailable = ref(false)
  has_schedule = list.exists(fun (entry) -> entry.windows != [], playlists)
  previous_active = ref([])

  def identity(r) =
    m = request.metadata(r)
    key = m["radio_track_key"]
    if key != "" then key else path.remove_extension(path.basename(request.filename(r))) end
  end

  def playlist_round(files) =
    if mode == "normal" then files else list.shuffle(files) end
  end

  def refresh() =
    if loaded_at() < 0. or time() >= loaded_at() + float_of_int(reload) then
      list.iter(fun (entry) -> begin
        files = playlist.files(mime_type="audio/x-mpegurl", entry.uri)
        if files != entry.files() then
          entry.set_files(files)
          entry.set_pending(playlist_round(files))
        end
      end, playlists)
      active = list.flatten(list.map(fun (entry) -> entry.files(), playlists))
      known_keys := list.filter(fun (pair) -> list.mem(fst(pair), active), known_keys())
      failed_until := list.filter(fun (pair) -> list.mem(fst(pair), active) and snd(pair) > time(), failed_until())
      loaded_at := time()
    end
  end

  def advance() =
    current_playlist := (current_playlist() + 1) mod list.length(playlists)
    quota := list.nth(playlists, current_playlist()).weight
  end

  next_callback = ref(fun () -> null())
  def next_request() =
    callback = next_callback()
    callback()
  end
  # Scheduled programmes choose at the track boundary, never from a stale prefetched queue.
  # Local files are resolved on demand; programmes without schedules keep async prefetch.
  %ifversion >= 2.4.5
  can_fetch_callback = ref({true})
  def can_fetch() =
    callback = can_fetch_callback()
    callback()
  end
  s = request.dynamic(
    id=id, prefetch=1, synchronous=has_schedule, available=can_fetch,
    retry_delay={if can_fetch() then 2. else 0.001 end}, next_request
  )
  # A positive retry delay prevents the synchronous feeder from spinning while a track plays.
  can_fetch_callback := {not has_schedule or not null.defined(s.current())}
  %else
  if has_schedule then
    error.raise(error.failure, "Playlist schedules require Liquidsoap 2.4.5 or newer.")
  end
  s = request.dynamic(id=id, prefetch=1, retry_delay=2., next_request)
  %endif

  def pick(entry, allow_repeat) =
    selected = ref(null())
    # A second round avoids getting stuck behind the last name of a shuffled round
    rounds = ref(0)
    while not null.defined(selected()) and rounds() < 2 do
      if mode == "random" or entry.pending() == [] or rounds() > 0 then
        entry.set_pending(playlist_round(entry.files()))
      end
      candidates = ref(entry.pending())
      while not null.defined(selected()) and candidates() != [] do
        uri = list.hd(candidates())
        candidates := list.tl(candidates())
        cached_key = list.assoc(default="", uri, known_keys())
        retry_at = list.assoc(default=0., uri, failed_until())
        if time() >= retry_at and (allow_repeat or cached_key == "" or cached_key != last_key()) then
          r = request.create(uri)
          if request.resolve(timeout=10., content_type=s, r) then
            key = identity(r)
            known_keys := [(uri, key), ...list.assoc.remove.all(uri, known_keys())]
            if allow_repeat or key != last_key() then
              selected := r
              entry.set_pending(list.filter(fun (candidate) -> candidate != uri, entry.pending()))
            else
              request.destroy(r)
            end
          else
            request.destroy(r)
            failed_until := [(uri, time() + 30.), ...list.assoc.remove.all(uri, failed_until())]
          end
        end
      end
      ref.incr(rounds)
    end
    selected()
  end

  def choose(allow_repeat, eligible) =
    selected = ref(null())
    attempts = ref(0)
    while eligible != [] and not null.defined(selected()) and attempts() < list.length(playlists) do
      entry = list.nth(playlists, current_playlist())
      if list.mem(current_playlist(), eligible) then selected := pick(entry, allow_repeat) end
      if null.defined(selected()) then
        quota := quota() - 1
        if quota() == 0 then advance() end
      else
        advance()
      end
      ref.incr(attempts)
    end
    selected()
  end

  def next() =
    refresh()
    minute = schedule_time()
    active = ref([])
    regular = ref([])
    index = ref(0)
    list.iter(fun (entry) -> begin
      if entry.windows == [] then
        regular := [...regular(), index()]
      elsif list.exists(fun (window) -> minute >= window.start and minute < window.stop, entry.windows) then
        active := [...active(), index()]
      end
      ref.incr(index)
    end, playlists)
    if active() != previous_active() then
      previous_active := active()
      current_playlist := 0
      quota := list.hd(playlists).weight
    end
    # Active schedules take priority, even if their only playable track must repeat.
    result = choose(false, active())
    result = if null.defined(result) then result else choose(true, active()) end
    result = if null.defined(result) then result else choose(false, regular()) end
    result = if null.defined(result) then result else choose(true, regular()) end
    if null.defined(result) then
      key = identity(null.get(result))
      is_repeat = key == last_key()
      if is_repeat and not repeating() then
        log(label=id, level=2, "No different playable filename is available in the eligible playlists; allowing repetition until another track is available.")
      end
      repeating := is_repeat
      unavailable := false
      last_key := key
    elsif not unavailable() then
      log(label=id, level=2, "No playable tracks are available; retrying with a bounded delay.")
      unavailable := true
    end
    result
  end
  next_callback := next

  def remember_played(m) =
    key = m["radio_track_key"]
    played_key := if key != "" then key else path.remove_extension(path.basename(metadata.filename(m))) end
  end
  # Queued requests discarded when a source sleeps were never played
  %ifversion >= 2.4
  s.on_track(synchronous=true, remember_played)
  s.on_shutdown(synchronous=true, {last_key := played_key()})
  %else
  s.on_track(remember_played)
  s.on_shutdown({last_key := played_key()})
  %endif
  s
end
