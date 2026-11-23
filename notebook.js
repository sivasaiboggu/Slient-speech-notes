/* The notebook keeps temporary captures in memory and saves chosen notes locally. */
(() => {
  'use strict';

  const CLIP_LIMIT = 12;
  const TITLE_LIMIT = 80;
  const BODY_LIMIT = 1000;

  function timecode(seconds) {
    const total = Math.floor(Math.max(0, seconds));
    const minutes = String(Math.floor(total / 60)).padStart(2, '0');
    return minutes + ':' + String(total % 60).padStart(2, '0');
  }

  function attachPlayback(row, entry, activate) {
    const video = row.querySelector('video');
    const player = row.querySelector('details');
    const play = row.querySelector('.play-btn');
    const seek = row.querySelector('.seek');
    const time = row.querySelector('.playback-time');
    const error = row.querySelector('.player-status');
    const recordedDuration = Math.max(0.1, entry.durationMs / 1000);

    const duration = () => Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : recordedDuration;

    function updateTimeline() {
      const length = duration();
      const elapsed = Math.min(video.currentTime, length);
      seek.max = length;
      seek.value = elapsed;
      seek.setAttribute('aria-valuetext', timecode(elapsed) + ' of ' + timecode(length));
      time.textContent = timecode(elapsed) + ' / ' + timecode(length);
    }

    play.addEventListener('click', async () => {
      if (!video.paused) {
        video.pause();
        return;
      }
      try {
        if (video.ended) video.currentTime = 0;
        await video.play();
        error.textContent = '';
      } catch {
        if (player.open) error.textContent = 'Could not play this clip. Try downloading it.';
      }
    });
    seek.addEventListener('input', () => {
      video.currentTime = seek.valueAsNumber;
      updateTimeline();
    });
    player.addEventListener('toggle', () => {
      if (!player.open && !video.paused) video.pause();
    });
    video.addEventListener('play', () => {
      activate(video);
      play.textContent = 'Pause';
    });
    video.addEventListener('pause', () => { play.textContent = 'Play'; });
    video.addEventListener('ended', () => { play.textContent = 'Replay'; });
    video.addEventListener('error', () => { error.textContent = 'Could not load this clip. Try downloading it.'; });
    for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked']) {
      video.addEventListener(event, updateTimeline);
    }
    updateTimeline();
  }

  window.createNotebook = fallbackFocus => {
    const list = document.getElementById('clipList');
    const empty = document.getElementById('clipEmpty');
    const count = document.getElementById('clipCount');
    const status = document.getElementById('notebookStatus');
    const review = document.getElementById('reviewClip');
    const store = window.noteStore;
    const rows = new Map();
    let sequence = 0;
    let playing = null;
    let reviewRow = null;

    function updateCount() {
      if (rows.size) empty.remove();
      else if (!empty.isConnected) list.append(empty);
      count.textContent = `${rows.size} clip${rows.size === 1 ? '' : 's'}`;
    }

    function removeRow(row) {
      const video = row.querySelector('video');
      if (!video.paused) video.pause();
      if (playing === video) playing = null;
      if (reviewRow === row) {
        if (document.activeElement === review) fallbackFocus().focus();
        reviewRow = null;
        review.hidden = true;
      }
      URL.revokeObjectURL(video.getAttribute('src'));
      rows.delete(row.id);
      row.remove();
      updateCount();
    }

    function prune() {
      const unsaved = Array.from(list.querySelectorAll('.clip[data-saved="false"]'));
      let excess = unsaved.length - CLIP_LIMIT;
      let removed = false;
      for (const row of unsaved.reverse()) {
        if (excess <= 0) break;
        if (row.hasAttribute('aria-busy')) continue;
        if (row.contains(document.activeElement)) fallbackFocus().focus();
        removeRow(row);
        excess -= 1;
        removed = true;
      }
      return removed;
    }

    function createRow(entry) {
      sequence = Math.max(sequence, entry.number);
      const row = document.createElement('li');
      const url = URL.createObjectURL(entry.blob);
      const date = new Date(entry.capturedAt);
      const extension = entry.blob.type.startsWith('video/mp4') ? 'mp4' : 'webm';
      const sizeKb = Math.max(1, Math.round(entry.blob.size / 1024));
      const clipName = 'Clip ' + entry.number;
      const formatDate = new Intl.DateTimeFormat(undefined, {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      });

      row.id = 'take-' + entry.id;
      row.className = 'clip';
      row.dataset.capturedAt = entry.capturedAt;
      row.innerHTML = `
        <div class="clip-meta">
          <h3 class="clip-title" tabindex="-1"></h3>
          <span class="clip-state"></span>
          <p class="clip-details"><time></time><span class="file-size"></span></p>
        </div>
        <p class="clip-body" hidden></p>
        <details class="clip-player">
          <summary>Playback</summary>
          <video playsinline preload="metadata"></video>
          <div class="playback-controls">
            <button class="button play-btn" type="button">Play</button>
            <input class="seek" type="range" min="0" step="0.01">
            <span class="playback-time" aria-hidden="true"></span>
          </div>
          <p class="player-status" role="status"></p>
        </details>
        <div class="clip-actions">
          <button class="button primary edit-btn" type="button" aria-expanded="false"></button>
          <a class="button download-btn">Download</a>
          <button class="button delete-btn" type="button">Delete</button>
          <button class="button transcribe-btn" type="button">Transcription help</button>
        </div>
        <form class="note-editor" hidden>
          <label>Title <input name="title" required></label>
          <label>Note <textarea name="body" rows="3"></textarea></label>
          <p class="edit-error" role="status"></p>
          <div class="clip-actions">
            <button class="button primary" type="submit">Save note</button>
            <button class="button cancel-edit" type="button">Cancel</button>
          </div>
        </form>
        <div class="delete-confirm" hidden>
          <p>Delete this note and its video from this browser?</p>
          <div class="clip-actions">
            <button class="button confirm-delete" type="button">Delete note</button>
            <button class="button cancel-delete" type="button">Cancel</button>
          </div>
        </div>
        <p class="clip-note" role="status" hidden></p>`;

      const title = row.querySelector('.clip-title');
      const body = row.querySelector('.clip-body');
      const label = row.querySelector('time');
      label.dateTime = date.toISOString();
      label.textContent = formatDate.format(date);
      row.querySelector('.file-size').textContent = ' · ' + sizeKb + ' KB';

      const video = row.querySelector('video');
      video.setAttribute('src', url);
      video.setAttribute('aria-label', 'Video for ' + clipName);
      row.querySelector('.seek').setAttribute('aria-label', 'Seek in ' + clipName);
      row.querySelector('details').open = !entry.revision;
      const download = row.querySelector('.download-btn');
      download.href = url;
      download.download = `silent-speech-clip-${entry.number}.${extension}`;
      attachPlayback(row, entry, next => {
        if (playing && playing !== next) playing.pause();
        playing = next;
      });

      const edit = row.querySelector('.edit-btn');
      const form = row.querySelector('form');
      const titleInput = form.elements.title;
      const bodyInput = form.elements.body;
      const error = row.querySelector('.edit-error');
      const remove = row.querySelector('.delete-btn');
      const confirm = row.querySelector('.delete-confirm');
      const deleteNote = confirm.querySelector('.confirm-delete');
      const cancelDelete = confirm.querySelector('.cancel-delete');
      const transcribe = row.querySelector('.transcribe-btn');
      const scope = row.querySelector('.clip-note');
      title.id = row.id + '-title';
      form.id = row.id + '-editor';
      scope.id = row.id + '-scope';
      edit.setAttribute('aria-controls', form.id);
      transcribe.setAttribute('aria-controls', scope.id);
      for (const control of [edit, remove, download, row.querySelector('.play-btn')]) {
        control.setAttribute('aria-describedby', title.id);
      }
      titleInput.maxLength = TITLE_LIMIT;
      bodyInput.maxLength = BODY_LIMIT;

      function reflectEntry() {
        row.dataset.saved = Boolean(entry.revision);
        title.textContent = entry.title || clipName;
        body.textContent = entry.body || '';
        body.hidden = !entry.body;
        edit.textContent = entry.revision ? 'Edit note' : 'Add note';
        row.querySelector('.clip-state').textContent = entry.revision ? 'Saved' : 'This tab';
      }

      function closeEditor() {
        form.hidden = true;
        edit.setAttribute('aria-expanded', 'false');
        edit.focus();
      }

      function setBusy(controls, busy) {
        if (busy) row.setAttribute('aria-busy', 'true');
        else row.removeAttribute('aria-busy');
        for (const control of controls) control.disabled = busy;
      }

      function deleteRow() {
        const sibling = row.nextElementSibling || row.previousElementSibling;
        const moveFocus = row.contains(document.activeElement);
        removeRow(row);
        if (moveFocus) (sibling?.querySelector('.delete-btn') || fallbackFocus()).focus();
      }

      edit.addEventListener('click', () => {
        if (!form.hidden) {
          titleInput.focus();
          return;
        }
        confirm.hidden = true;
        titleInput.value = entry.title || clipName;
        bodyInput.value = entry.body || '';
        error.textContent = '';
        form.hidden = false;
        edit.setAttribute('aria-expanded', 'true');
        titleInput.focus();
        titleInput.select();
      });
      row.querySelector('.cancel-edit').addEventListener('click', closeEditor);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (row.hasAttribute('aria-busy')) return;
        const name = titleInput.value.trim();
        const note = bodyInput.value.trim();
        if (!name || name.length > TITLE_LIMIT || note.length > BODY_LIMIT) {
          error.textContent = 'Enter a title of 1–80 characters and a note up to 1,000 characters.';
          titleInput.focus();
          return;
        }

        const controls = [...form.elements, edit, remove];
        setBusy(controls, true);
        error.textContent = '';
        try {
          const saved = { ...entry, title: name, body: note, revision: (entry.revision || 0) + 1 };
          await store.save(saved);
          entry = saved;
          reflectEntry();
          status.textContent = 'Saved “' + name + '” in this browser.';
          setBusy(controls, false);
          closeEditor();
        } catch (problem) {
          setBusy(controls, false);
          error.textContent = problem.name === 'InvalidStateError'
            ? 'This note changed in another tab. Copy your edits before reopening the notebook.'
            : 'Could not save this note. Your edits are still here. Try again or download the clip.';
          titleInput.focus();
        }
      });

      transcribe.addEventListener('click', () => {
        scope.hidden = false;
        scope.textContent = 'Transcription is not available in this prototype.';
        transcribe.disabled = true;
        download.focus();
      });
      remove.addEventListener('click', () => {
        if (!entry.revision) {
          deleteRow();
          return;
        }
        form.hidden = true;
        edit.setAttribute('aria-expanded', 'false');
        confirm.hidden = false;
        cancelDelete.focus();
      });
      cancelDelete.addEventListener('click', () => {
        confirm.hidden = true;
        remove.focus();
      });
      deleteNote.addEventListener('click', async () => {
        const controls = [deleteNote, cancelDelete, remove, edit];
        setBusy(controls, true);
        try {
          await store.remove(entry.id);
          setBusy(controls, false);
          cancelDelete.focus();
          deleteRow();
          status.textContent = 'Note deleted.';
        } catch {
          setBusy(controls, false);
          status.textContent = 'Could not delete this note. Try again.';
          cancelDelete.focus();
        }
      });

      reflectEntry();
      rows.set(row.id, row);
      const older = Array.from(list.children).find(item => Number(item.dataset.capturedAt) < entry.capturedAt);
      list.insertBefore(row, older || null);
      updateCount();
      return row;
    }

    review.addEventListener('click', event => {
      if (!reviewRow) return;
      event.preventDefault();
      reviewRow.querySelector('details').open = true;
      reviewRow.querySelector('.clip-title').focus();
    });

    if (window.indexedDB) {
      store.list().then(entries => {
        for (const entry of entries) createRow(entry);
      }).catch(() => {
        status.textContent = 'Saved notes could not be loaded. You can still record and download clips.';
      });
    }

    return {
      limit: CLIP_LIMIT,
      addRecording({ blob, capturedAt, durationMs }) {
        const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(36)).join('-');
        const row = createRow({ id, blob, capturedAt, durationMs, number: ++sequence });
        if (!reviewRow || capturedAt >= Number(reviewRow.dataset.capturedAt)) {
          reviewRow = row;
          review.hidden = false;
        }
        return prune();
      },
    };
  };
})();
