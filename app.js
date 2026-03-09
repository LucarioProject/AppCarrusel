// Sencilla "base de datos" usando IndexedDB para guardar muchas fotos sin límite tan estricto
const DB_NAME = "appCarruselDB";
const DB_VERSION = 1;
const STORE_NAME = "photos";

// Configuración Cloudinary (solo datos públicos, nunca expongas el API secret)
// Cambia CLOUD_NAME y UPLOAD_PRESET por los de tu cuenta/preset.
const CLOUD_NAME = "dtrvc1cpz"; // tu cloud name
const UPLOAD_PRESET = "appcarrusel_unsigned"; // nombre del upload preset SIN firmar
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

let db;
let photos = [];
let currentIndex = 0;
let autoplayInterval = null;

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

function setMessage(text, type) {
  const el = $("#upload-message");
  el.textContent = text || "";
  el.classList.remove("message-success", "message-error");
  if (type === "success") el.classList.add("message-success");
  if (type === "error") el.classList.add("message-error");
}

function uploadToCloudinary(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", UPLOAD_PRESET);

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

function startAutoplay() {
  if (autoplayInterval || photos.length <= 1) return;
  autoplayInterval = setInterval(nextPhoto, 3500);
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
    setMessage("");

    const file = input.files && input.files[0];
    if (!file) {
      setMessage("Primero selecciona o toma una foto.", "error");
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setMessage("La imagen no puede superar los 10 MB.", "error");
      return;
    }

    try {
      const description = $("#description-input").value.trim();
      if (!description) {
        setMessage("Agrega una descripción para la foto.", "error");
        return;
      }
      const createdAt = Date.now();

      // 1) Subir a Cloudinary
      const cloudinaryResult = await uploadToCloudinary(file);

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
      setMessage("Foto subida a Cloudinary y guardada en el carrusel.", "success");

      // Reset suave del formulario
      input.value = "";
      $("#description-input").value = "";
      // mantenemos la preview actual
      showView("carousel");
    } catch (err) {
      console.error(err);
      setMessage(
        "Ocurrió un error al subir o guardar la foto.",
        "error"
      );
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

  initNav();
  initForm();
  initCarousel();
}

document.addEventListener("DOMContentLoaded", bootstrap);

