/* IndexedDB stores a saved note and its video in a single transaction. */
(() => {
  'use strict';

  let opening;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open('silent-speech-notebook', 1);
        let blocked = false;
        request.onupgradeneeded = () => request.result.createObjectStore('notes', { keyPath: 'id' });
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
          blocked = true;
          reject(new Error('Notebook storage is busy.'));
        };
        request.onsuccess = () => {
          const db = request.result;
          if (blocked) {
            db.close();
            return;
          }
          db.onversionchange = () => {
            db.close();
            opening = undefined;
          };
          resolve(db);
        };
      }).catch(error => {
        opening = undefined;
        throw error;
      });
    }
    return opening;
  }

  async function transact(mode, run) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('notes', mode);
      let value;
      let conflict = false;
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(conflict
        ? new DOMException('The note changed in another tab.', 'InvalidStateError')
        : transaction.error || new Error('Notebook storage was interrupted.'));
      run(transaction.objectStore('notes'), result => { value = result; }, () => {
        conflict = true;
        transaction.abort();
      });
    });
  }

  window.noteStore = {
    list: () => transact('readonly', (notes, result) => {
      const request = notes.getAll();
      request.onsuccess = () => result(request.result);
    }),
    save: note => transact('readwrite', (notes, result, abort) => {
      if (note.revision === 1) {
        notes.add(note);
        return;
      }
      const request = notes.get(note.id);
      request.onsuccess = () => {
        if (request.result?.revision === note.revision - 1) notes.put(note);
        else abort();
      };
    }),
    remove: id => transact('readwrite', notes => notes.delete(id)),
  };
})();
