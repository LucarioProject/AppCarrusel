export default async function handler(req, res) {
  // Manejo simple de CORS para poder llamar desde cualquier origen si lo necesitas
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const {
    CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET,
    CLOUDINARY_FOLDER,
  } = process.env;

  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    res.status(500).json({ error: "Cloudinary env vars not configured" });
    return;
  }

  const auth = Buffer.from(
    `${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`
  ).toString("base64");

  const expression = CLOUDINARY_FOLDER
    ? `folder:${CLOUDINARY_FOLDER}/*`
    : "resource_type:image";

  try {
    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/search`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expression,
          max_results: 100,
          sort_by: [{ created_at: "asc" }],
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error("Cloudinary search error:", text);
      res.status(500).json({ error: "Cloudinary search failed" });
      return;
    }

    const data = await response.json();
    const items =
      data.resources?.map((r) => ({
        url: r.secure_url,
        description:
          (r.context &&
            r.context.custom &&
            r.context.custom.description) ||
          "",
        createdAt: Date.parse(r.created_at),
        publicId: r.public_id,
      })) ?? [];

    res.status(200).json(items);
  } catch (err) {
    console.error("Cloudinary API error:", err);
    res.status(500).json({ error: "Unexpected error" });
  }
}

