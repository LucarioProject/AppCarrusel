// Sencilla "base de datos" usando IndexedDB para guardar muchas fotos sin límite tan estricto
const DB_NAME = "appCarruselDB";
const DB_VERSION = 1;
const STORE_NAME = "photos";

// Configuración Cloudinary (solo datos públicos, nunca expongas el API secret)
// Cambia CLOUD_NAME y UPLOAD_PRESET por los de tu cuenta/preset.
const CLOUD_NAME = "dtrvc1cpz"; // tu cloud name
const UPLOAD_PRESET = "appcarrusel_unsigned"; // nombre del upload preset SIN firmar
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DESC_LENGTH = 60;
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
// URL opcional de un backend seguro que lista fotos desde Cloudinary.
// En Vercel, si el front y el API viven juntos, basta con usar la ruta relativa:
const BACKEND_LIST_URL = "/api/photos";

let db;
let photos = [];
let currentIndex = 0;
let autoplayInterval = null;
let cameraPermissionRequested = false;
let uploadInProgress = false;

// --- IndexedDB helpers ---
function openDb() {
  return new Promise((resolve, reject) => {
    if (db) {
      resolve(db);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

function savePhotoToDb(photo) {
  return openDb().then(
    (database) =>
      new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.add(photo);

        request.onsuccess = (event) => {
          resolve({ ...photo, id: event.target.result });
        };
        request.onerror = () => reject(request.error);
      })
  );
}

function getAllPhotosFromDb() {
  return openDb().then(
    (database) =>
      new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const request = store.index("createdAt").getAll();

        request.onsuccess = () => {
          // Ordenar por fecha de creación (más antiguas primero)
          const result = request.result || [];
          result.sort((a, b) => a.createdAt - b.createdAt);
          resolve(result);
        };
        request.onerror = () => reject(request.error);
      })
  );
}

function clearAllPhotosFromDb() {
  return openDb().then(
    (database) =>
      new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      })
  );
}

// --- UI helpers ---
function $(selector) {
  return document.querySelector(selector);
}

let successDismissTimer = null;
let onSuccessMessageTransitionEnd = null;

function setMessage(text, type) {
  const el = $("#upload-message");
  if (successDismissTimer) {
    clearTimeout(successDismissTimer);
    successDismissTimer = null;
  }
  if (onSuccessMessageTransitionEnd) {
    el.removeEventListener("transitionend", onSuccessMessageTransitionEnd);
    onSuccessMessageTransitionEnd = null;
  }

  el.classList.remove("message-success", "message-error", "message-dismissing");
  el.textContent = text || "";
  if (!text) {
    return;
  }
  if (type === "success") {
    el.classList.add("message-success");
    successDismissTimer = setTimeout(() => {
      el.classList.add("message-dismissing");
    }, 5000);
    onSuccessMessageTransitionEnd = (e) => {
      if (e.target !== el) return;
      if (e.propertyName !== "transform") return;
      el.classList.remove("message-success", "message-dismissing");
      el.textContent = "";
      el.removeEventListener("transitionend", onSuccessMessageTransitionEnd);
      onSuccessMessageTransitionEnd = null;
    };
    el.addEventListener("transitionend", onSuccessMessageTransitionEnd);
  } else if (type === "error") {
    el.classList.add("message-error");
  }
}

function setUploadFormBusy(loading) {
  const btn = $("#upload-submit");
  const input = $("#photo-input");
  const desc = $("#description-input");
  const wrapper = $("#file-input-wrapper");
  if (btn) {
    btn.disabled = loading;
    btn.setAttribute("aria-busy", loading ? "true" : "false");
    btn.classList.toggle("is-loading", loading);
    const text = btn.querySelector(".btn-text");
    if (text) text.textContent = loading ? "Subiendo…" : "Guardar foto";
  }
  if (input) input.disabled = loading;
  if (desc) desc.disabled = loading;
  if (wrapper) wrapper.classList.toggle("is-disabled", loading);
}

function uploadToCloudinary(file, description) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", UPLOAD_PRESET);
  if (description) {
    // Guarda la descripción como contexto en Cloudinary para poder leerla luego desde el backend
    formData.append("context", `description=${description}`);
  }

  return fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
    {
      method: "POST",
      body: formData,
    }
  ).then((res) => {
    if (!res.ok) {
      throw new Error("Error al subir la imagen a Cloudinary");
    }
    return res.json();
  });
}

function showView(view) {
  const uploadView = $("#view-upload");
  const carouselView = $("#view-carousel");
  const uploadBtn = $("#nav-upload");
  const carouselBtn = $("#nav-carousel");

  const isUpload = view === "upload";
  uploadView.classList.toggle("view-active", isUpload);
  carouselView.classList.toggle("view-active", !isUpload);

  uploadBtn.classList.toggle("nav-btn-active", isUpload);
  carouselBtn.classList.toggle("nav-btn-active", !isUpload);

  if ("inert" in uploadView) {
    uploadView.inert = !isUpload;
    carouselView.inert = isUpload;
  }
}

function updateCarouselControls() {
  const emptyState = $("#empty-state");
  const container = $("#carousel-container");

  if (!photos.length) {
    emptyState.classList.remove("hidden");
    container.classList.add("hidden");
    stopAutoplay();
    return;
  }

  emptyState.classList.add("hidden");
  container.classList.remove("hidden");

  const photo = photos[currentIndex];
  const imgEl = $("#carousel-image");
  const descEl = $("#carousel-description");
  const dateEl = $("#carousel-date");
  const indexEl = $("#carousel-index");
  const totalEl = $("#carousel-total");

  // Si viene de Cloudinary usamos la URL remota, si no caemos al blob local
  if (photo.url) {
    imgEl.src = photo.url;
    imgEl.onload = null;
  } else if (photo.blob) {
    const objectUrl = URL.createObjectURL(photo.blob);
    imgEl.src = objectUrl;
    imgEl.onload = () => {
      URL.revokeObjectURL(objectUrl);
    };
  } else {
    imgEl.removeAttribute("src");
  }

  descEl.textContent = photo.description || "Sin descripción";

  const formatted = new Date(photo.createdAt).toLocaleString("es-CR", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  dateEl.textContent = `Guardada el ${formatted}`;

  indexEl.textContent = currentIndex + 1;
  totalEl.textContent = photos.length;
}

function nextPhoto() {
  if (!photos.length) return;
  currentIndex = (currentIndex + 1) % photos.length;
  updateCarouselControls();
}

function prevPhoto() {
  if (!photos.length) return;
  currentIndex = (currentIndex - 1 + photos.length) % photos.length;
  updateCarouselControls();
}

function toggleFullscreen() {
  const container = document.getElementById("carousel-container");
  if (!container) return;

  const fsElement =
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.msFullscreenElement;

  if (!fsElement) {
    if (container.requestFullscreen) {
      container.requestFullscreen();
    } else if (container.webkitRequestFullscreen) {
      container.webkitRequestFullscreen();
    } else if (container.msRequestFullscreen) {
      container.msRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    }
  }
}

function startAutoplay() {
  if (autoplayInterval || photos.length <= 1) return;
  autoplayInterval = setInterval(nextPhoto, 5000);
  $("#btn-play").textContent = "Pausar";
}

function stopAutoplay() {
  if (!autoplayInterval) return;
  clearInterval(autoplayInterval);
  autoplayInterval = null;
  $("#btn-play").textContent = "Reproducir";
}

// --- Event wiring ---
function initNav() {
  $("#nav-upload").addEventListener("click", () => showView("upload"));
  $("#nav-carousel").addEventListener("click", () => showView("carousel"));
}

function initForm() {
  const input = $("#photo-input");
  const previewContainer = $("#photo-preview-container");
  const previewImg = $("#photo-preview");
  const descInput = $("#description-input");
  const descCounter = $("#description-counter");

  const wrapper = document.getElementById("file-input-wrapper");
  if (wrapper && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    wrapper.addEventListener("click", async () => {
      if (uploadInProgress) return;
      if (cameraPermissionRequested) return;
      cameraPermissionRequested = true;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        // Cerramos enseguida, solo queremos disparar el permiso
        stream.getTracks().forEach((t) => t.stop());
      } catch (err) {
        console.warn("No se pudo acceder a la cámara:", err);
      }
    });
  }

  if (descCounter) {
    descCounter.textContent = `${MAX_DESC_LENGTH} caracteres restantes`;
  }

  if (descInput) {
    descInput.addEventListener("input", () => {
      let value = descInput.value || "";
      // quitar emojis
      value = value.replace(EMOJI_REGEX, "");
      // limitar longitud
      if (value.length > MAX_DESC_LENGTH) {
        value = value.slice(0, MAX_DESC_LENGTH);
      }
      if (value !== descInput.value) {
        descInput.value = value;
      }
      if (descCounter) {
        const remaining = MAX_DESC_LENGTH - value.length;
        descCounter.textContent = `${remaining} caracteres restantes`;
      }
    });
  }

  input.addEventListener("change", () => {
    setMessage("");
    const file = input.files && input.files[0];
    if (!file) {
      previewContainer.classList.add("hidden");
      previewImg.removeAttribute("src");
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setMessage("La imagen no puede superar los 10 MB.", "error");
      input.value = "";
      previewContainer.classList.add("hidden");
      previewImg.removeAttribute("src");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      previewImg.src = e.target.result;
      previewContainer.classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  });

  $("#upload-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (uploadInProgress) return;
    setMessage("");

    const file = input.files && input.files[0];
    if (!file) {
      setMessage("Debe tomar una foto", "error");
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setMessage("La imagen no puede superar los 10 MB.", "error");
      return;
    }

    const description = descInput ? descInput.value.trim() : "";
    if (!description) {
      setMessage("Agrega una descripción para la foto.", "error");
      return;
    }

    uploadInProgress = true;
    setUploadFormBusy(true);

    try {
      const createdAt = Date.now();

      // 1) Subir a Cloudinary (incluyendo descripción como contexto)
      const cloudinaryResult = await uploadToCloudinary(file, description);

      // 2) Guardar solo metadatos + URL en IndexedDB (sin el blob grande)
      const saved = await savePhotoToDb({
        description,
        createdAt,
        url: cloudinaryResult.secure_url,
        publicId: cloudinaryResult.public_id,
      });

      photos.push(saved);
      currentIndex = photos.length - 1;
      updateCarouselControls();
      setMessage("Foto cargada, ve a carrusel para verla", "success");

      // Reset suave del formulario (se mantiene en la pestaña Subir foto)
      input.value = "";
      $("#description-input").value = "";
      previewImg.removeAttribute("src");
      previewContainer.classList.add("hidden");
    } catch (err) {
      console.error(err);
      setMessage(
        "Ocurrió un error al subir o guardar la foto.",
        "error"
      );
    } finally {
      uploadInProgress = false;
      setUploadFormBusy(false);
    }
  });
}

function initCarousel() {
  $("#btn-next").addEventListener("click", () => {
    stopAutoplay();
    nextPhoto();
  });

  $("#btn-prev").addEventListener("click", () => {
    stopAutoplay();
    prevPhoto();
  });

  $("#btn-play").addEventListener("click", () => {
    if (autoplayInterval) {
      stopAutoplay();
    } else {
      startAutoplay();
    }
  });

  const fullscreenBtn = document.getElementById("btn-fullscreen");
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener("click", () => {
      toggleFullscreen();
    });
  }
}

async function bootstrap() {
  try {
    await openDb();
    photos = await getAllPhotosFromDb();
    currentIndex = 0;
    updateCarouselControls();
  } catch (err) {
    console.error("No se pudo inicializar la base local:", err);
  }

  // Si se configuró un backend seguro, sincronizamos periódicamente con Cloudinary
  if (BACKEND_LIST_URL) {
    const syncFromBackend = async () => {
      try {
        const res = await fetch(BACKEND_LIST_URL);
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data)) return;

        photos = data;
        if (currentIndex >= photos.length) {
          currentIndex = Math.max(photos.length - 1, 0);
        }
        updateCarouselControls();
      } catch (err) {
        console.error("No se pudieron sincronizar las fotos remotas:", err);
      }
    };

    // Primero intento inmediato y luego cada 15 segundos
    await syncFromBackend();
    setInterval(syncFromBackend, 15000);
  }

  initNav();
  initForm();
  initCarousel();
  showView("upload");
}

document.addEventListener("DOMContentLoaded", bootstrap);

