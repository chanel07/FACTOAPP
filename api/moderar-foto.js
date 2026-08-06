// /api/moderar-foto.js
// Revisa con Gemini si una foto recién subida contiene contenido inapropiado
// (desnudez, contenido sexual, gore) ANTES de que el facto se publique.
// Requiere en Vercel (proyecto Facto) la variable de entorno:
//   GEMINI_API_KEY -> tu llave de Google AI Studio (sirve la misma de HuellaViva)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { foto_url } = req.body || {};
  if (!foto_url || !foto_url.startsWith('https://res.cloudinary.com/')) {
    return res.status(400).json({ error: 'Falta la foto_url válida de Cloudinary' });
  }

  try {
    // 1. Descargo la imagen y la convierto a base64 (Gemini la necesita así)
    const imgRes = await fetch(foto_url);
    if (!imgRes.ok) throw new Error('No se pudo descargar la foto');
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const base64 = buffer.toString('base64');
    const mime = imgRes.headers.get('content-type') || 'image/jpeg';

    // 2. Le pregunto a Gemini
    const prompt = `Eres el moderador de contenido de una app comunitaria de barrio en Colombia donde vecinos reportan situaciones locales (cortes de servicios, seguridad, mascotas perdidas, eventos, estado de vías).

Analiza la imagen y responde SOLO con un JSON válido, sin texto adicional ni markdown:
{"apta": true o false, "razon": "explicación corta en español"}

La imagen NO es apta (apta: false) únicamente si contiene:
- Desnudez o contenido sexual de cualquier tipo
- Gore extremo o mutilaciones explícitas mostradas de forma gratuita

La imagen SÍ es apta (apta: true) si muestra situaciones normales de barrio aunque sean fuertes: accidentes de tránsito, calles inundadas, basura, daños, personas discutiendo, animales heridos, etc. Ante la duda razonable, marca apta: true.`;

    // Google retira y renombra modelos con frecuencia; probamos en orden
    // hasta que alguno responda, para que el filtro no muera con un solo nombre
    const MODELOS = [
      'gemini-3-flash',
      'gemini-3.1-flash-lite',
      'gemini-flash-latest',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash'
    ];

    const cuerpoPeticion = JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mime, data: base64 } }
        ]
      }],
      generationConfig: { temperature: 0 },
      // Para moderación necesitamos que Gemini analice la imagen en vez de
      // negarse a responder; el veredicto lo da nuestro prompt, no su filtro interno
      safetySettings: [
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }
      ]
    });

    let geminiRes = null;
    let data = null;
    let modeloUsado = null;

    for (const modelo of MODELOS) {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: cuerpoPeticion
        }
      );
      data = await geminiRes.json();

      if (geminiRes.ok) {
        modeloUsado = modelo;
        break;
      }
      // 404 = ese modelo ya no existe: probamos el siguiente de la lista
      if (data?.error?.code === 404) {
        console.log(`Modelo ${modelo} no disponible (404), probando el siguiente...`);
        continue;
      }
      // Otro tipo de error (llave inválida, cuota, etc.): no tiene sentido seguir probando
      break;
    }

    if (!geminiRes.ok) {
      console.error('Error de Gemini con todos los modelos:', data);
      // Si Gemini falla por razones técnicas, dejamos pasar la foto para no bloquear la app
      // (la moderación comunitaria queda como respaldo)
      return res.status(200).json({ apta: true, razon: 'moderación no disponible' });
    }

    console.log('Moderación hecha con el modelo:', modeloUsado);

    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Si Gemini se negó a responder por sus filtros de seguridad, ese silencio
    // es en sí mismo el veredicto: la imagen es inapropiada
    const bloqueadoPorSeguridad =
      data?.promptFeedback?.blockReason ||
      data?.candidates?.[0]?.finishReason === 'SAFETY' ||
      data?.candidates?.[0]?.finishReason === 'IMAGE_SAFETY' ||
      (!texto && data?.candidates !== undefined);

    if (bloqueadoPorSeguridad && !texto) {
      console.log('Gemini bloqueó la imagen por seguridad -> rechazada');
      return res.status(200).json({ apta: false, razon: 'contenido inapropiado detectado' });
    }

    const limpio = texto.replace(/```json|```/g, '').trim();

    let veredicto;
    try {
      veredicto = JSON.parse(limpio);
    } catch (e) {
      console.error('Gemini no respondió JSON válido:', texto);
      // Respondió algo pero no en formato JSON: por precaución, rechazamos
      return res.status(200).json({ apta: false, razon: 'no se pudo verificar la foto' });
    }

    return res.status(200).json({
      apta: veredicto.apta !== false,
      razon: veredicto.razon || ''
    });
  } catch (e) {
    console.error('Error en moderar-foto:', e);
    // Falla abierta: ante un error técnico, no bloqueamos la publicación
    return res.status(200).json({ apta: true, razon: 'error técnico' });
  }
}
