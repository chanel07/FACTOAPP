// /api/moderar-video.js
// Revisa con Gemini si un video recién subido contiene contenido inapropiado,
// analizando varios fotogramas extraídos por Cloudinary (inicio, medio, fin).
// La moderación de video es más limitada que la de foto: revisa fotogramas
// puntuales, no cada segundo. La moderación comunitaria queda como respaldo.
// Requiere en Vercel: GEMINI_API_KEY

const MODELOS = [
  'gemini-3-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash'
];

// A partir de la URL del video en Cloudinary, arma URLs de fotogramas (JPG).
// Cloudinary genera un frame en el segundo indicado con la transformación so_<seg>.
function urlsDeFotogramas(videoUrl) {
  // videoUrl: https://res.cloudinary.com/<cloud>/video/upload/<publicid>.<ext>
  const idx = videoUrl.indexOf('/upload/');
  if (idx === -1) return [];
  const antes = videoUrl.slice(0, idx + 8); // incluye "/upload/"
  let despues = videoUrl.slice(idx + 8);
  // quito la extensión del final para ponerle .jpg
  despues = despues.replace(/\.[a-zA-Z0-9]+$/, '');
  // tres fotogramas: segundo 0, 3 y 8 (si el video es más corto, Cloudinary usa el último frame)
  return [0, 3, 8].map(seg => `${antes}so_${seg},w_640,c_limit/${despues}.jpg`);
}

async function fotogramaABase64(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString('base64');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { video_url } = req.body || {};
  if (!video_url || !video_url.startsWith('https://res.cloudinary.com/')) {
    return res.status(400).json({ error: 'Falta la video_url válida de Cloudinary' });
  }

  try {
    const frames = urlsDeFotogramas(video_url);
    if (frames.length === 0) {
      return res.status(200).json({ apta: true, razon: 'no se pudieron extraer fotogramas' });
    }

    // Descargo los fotogramas en paralelo
    const base64s = (await Promise.all(frames.map(fotogramaABase64))).filter(Boolean);
    if (base64s.length === 0) {
      return res.status(200).json({ apta: true, razon: 'fotogramas no disponibles' });
    }

    const prompt = `Eres el moderador de contenido de una app comunitaria de barrio en Colombia donde vecinos reportan situaciones locales (cortes de servicios, seguridad, mascotas, eventos, estado de vías).

Te doy varios fotogramas de un mismo video. Analízalos y responde SOLO con un JSON válido, sin texto adicional ni markdown:
{"apta": true o false, "razon": "explicación corta en español"}

El video NO es apto (apta: false) únicamente si ALGÚN fotograma contiene:
- Desnudez o contenido sexual de cualquier tipo
- Gore extremo o mutilaciones explícitas mostradas de forma gratuita

El video SÍ es apto (apta: true) si muestra situaciones normales de barrio aunque sean fuertes: accidentes de tránsito, calles inundadas, basura, daños, personas discutiendo, animales, etc. Ante la duda razonable, marca apta: true.`;

    const parts = [{ text: prompt }];
    base64s.forEach(b => parts.push({ inline_data: { mime_type: 'image/jpeg', data: b } }));

    const cuerpo = JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0 },
      safetySettings: [
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }
      ]
    });

    let geminiRes = null, data = null;
    for (const modelo of MODELOS) {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cuerpo }
      );
      data = await geminiRes.json();
      if (geminiRes.ok) break;
      if (data?.error?.code === 404) continue;
      break;
    }

    if (!geminiRes.ok) {
      console.error('Error de Gemini (video):', data);
      return res.status(200).json({ apta: true, razon: 'moderación no disponible' });
    }

    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const bloqueadoPorSeguridad =
      data?.promptFeedback?.blockReason ||
      data?.candidates?.[0]?.finishReason === 'SAFETY' ||
      data?.candidates?.[0]?.finishReason === 'IMAGE_SAFETY';

    if (bloqueadoPorSeguridad && !texto) {
      return res.status(200).json({ apta: false, razon: 'contenido inapropiado detectado' });
    }

    const limpio = texto.replace(/```json|```/g, '').trim();
    let veredicto;
    try {
      veredicto = JSON.parse(limpio);
    } catch (e) {
      console.error('Gemini no respondió JSON válido (video):', texto);
      return res.status(200).json({ apta: false, razon: 'no se pudo verificar el video' });
    }

    return res.status(200).json({ apta: veredicto.apta !== false, razon: veredicto.razon || '' });
  } catch (e) {
    console.error('Error en moderar-video:', e);
    return res.status(200).json({ apta: true, razon: 'error técnico' });
  }
}
