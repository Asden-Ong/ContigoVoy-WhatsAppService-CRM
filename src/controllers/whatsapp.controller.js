import whatsappService from "../services/whatsapp.service.js";
import logger from "../services/logger.service.js";

// NO importar mysql aquí arriba
let pool = null;

// Función para obtener la conexión solo cuando se necesite

/**
 * Obtiene el estado de la conexión de WhatsApp y el QR
 */
export async function getStatus(req, res) {
  try {
    const status = whatsappService.getStatus();
    res.json(status);
  } catch (error) {
    logger.error("Error al obtener estado de WhatsApp", {
      error: error.message,
    });
    res.status(500).json({
      success: false,
      message: "Error al obtener el estado",
    });
  }
}

/**
 * Solicita un nuevo código QR
 */
export async function requestQR(req, res) {
  try {
    if (whatsappService.isReady) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp ya está conectado",
      });
    }

    if (whatsappService.isInitializing) {
      return res.status(409).json({
        success: false,
        message: "Ya hay una operación en progreso",
      });
    }

    // Si no existe el socket, se inicializa
    if (!whatsappService.sock) {
      await whatsappService.initialize();
    } else {
      // Si existe, se destruye y reinicia
      await whatsappService.destroy();
      await whatsappService.initialize();
    }

    res.json({
      success: true,
      message: "Generando nuevo QR...",
    });
  } catch (error) {
    logger.error("Error al solicitar nuevo QR", { error: error.message });
    res.status(500).json({
      success: false,
      message: "Error al generar QR",
    });
  }
}

/**
 * Reinicia la sesión de WhatsApp
 */
export async function resetSession(req, res) {
  try {
    if (whatsappService.isInitializing) {
      return res.status(409).json({
        success: false,
        message: "Ya hay una operación de reseteo en progreso",
      });
    }

    await whatsappService.resetSession();

    res.json({
      success: true,
      message: "Sesión reseteada",
    });
  } catch (error) {
    logger.error("Error al resetear la sesión de WhatsApp", {
      error: error.message,
    });
    if (whatsappService.sock) {
      res.json({
        success: true,
        message: "Sesión reiniciada con advertencias. Generando QR...",
      });
    } else {
      res.status(500).json({
        success: false,
        message: "Error al reiniciar sesión",
      });
    }
  }
}

/**
 * Procesa una fuente de media (URL o Base64) y devuelve un Buffer y el Mimetype detectado
 * Soporta: imágenes, audios, videos, documentos
 */
async function processMedia(mediaSource) {
  if (!mediaSource) return { buffer: null, mimetype: null };

  let mediaBuffer;
  let detectedMimetype = null;

  if (mediaSource.startsWith("http://") || mediaSource.startsWith("https://")) {
    try {
      const response = await fetch(mediaSource);
      if (!response.ok) throw new Error("No se pudo descargar el archivo");
      detectedMimetype = response.headers.get("content-type") || null;
      mediaBuffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      logger.error("Error al descargar archivo desde URL", {
        error: error.message,
        url: mediaSource,
      });
      return { buffer: null, mimetype: null };
    }
  } else if (mediaSource.startsWith("data:")) {
    const parts = mediaSource.split(",");
    if (parts.length === 2) {
      const mimeMatch = parts[0].match(/data:([^;]+);/);
      detectedMimetype = mimeMatch ? mimeMatch[1] : null;
      mediaBuffer = Buffer.from(parts[1], "base64");
    }
  } else {
    mediaBuffer = Buffer.from(mediaSource, "base64");
  }

  return { buffer: mediaBuffer, mimetype: detectedMimetype };
}

/**
 * Alias para compatibilidad hacia atrás
 */
async function processImage(imageSource) {
  return processMedia(imageSource);
}

/**
 * Envía campaña de WhatsApp (llamado desde Laravel)
 */
export async function sendCampaign(req, res) {
  try {
    if (!whatsappService.isReady) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp no está conectado",
      });
    }

    const { phone, message, image, messages } = req.body;

    // Limpiar número
    const numberId = (
      phone ||
      (messages && messages[0] && messages[0].phone) ||
      ""
    ).replace(/\D/g, "");
    if (numberId.length < 10 || numberId.length > 15) {
      return res
        .status(400)
        .json({ success: false, message: "Número de teléfono no válido" });
    }
    const jid = await whatsappService.validateNumber(
      `${numberId}@s.whatsapp.net`,
    );
    if (!jid)
      return res
        .status(404)
        .json({ success: false, message: "Número no registrado" });

    // Función interna para enviar un mensaje individual
    const sendOne = async (msgText, msgImage) => {
      try {
        if (msgImage) {
          const { buffer, mimetype } = await processImage(msgImage);
          return await whatsappService.sendImage(
            jid,
            buffer,
            msgText,
            mimetype,
          );
        }
        return await whatsappService.sendMessage(jid, msgText);
      } catch (err) {
        logger.error("Error enviando mensaje individual en campaña", {
          error: err.message,
        });
        throw err;
      }
    };

    // Si viene un array de mensajes (Secuencia)
    if (Array.isArray(messages) && messages.length > 0) {
      // Enviamos respuesta inmediata para que Laravel no espere
      res.json({ success: true, message: "Secuencia de mensajes iniciada" });

      let currentDelay = 0;
      for (const msg of messages) {
        currentDelay += msg.delay || 0;
        setTimeout(async () => {
          try {
            await sendOne(msg.message, msg.image);
            logger.info("Mensaje de secuencia enviado", {
              phone: numberId,
              delay: msg.delay,
            });
          } catch (e) {
            logger.error("Fallo en mensaje de secuencia", { error: e.message });
          }
        }, currentDelay * 60000); // convertir minutos a ms
      }
      return;
    }

    // Si es un mensaje único (Tradicional)
    if (!message)
      return res
        .status(400)
        .json({ success: false, message: "Mensaje obligatorio" });

    const result = await sendOne(message, image);
    logger.info("Campaña única enviada correctamente", { phone: numberId });
    res.json(result);
  } catch (error) {
    logger.error("Error al enviar campaña de WhatsApp", {
      error: error.message,
    });
    res.status(500).json({
      success: false,
      message: "Error al enviar la campaña: " + error.message,
    });
  }
}

// Sincroniza mensajes (util para el n8n)
//
// Autenticacion: el CRM protege /api/* en su proxy (whato-crm-/src/proxy.ts) y
// deja pasar las llamadas entre servidores que traen `x-api-key` con el valor
// de su INTERNAL_API_KEY. Esa variable tiene que valer LO MISMO en los dos
// proyectos; si no, el proxy responde 401 y la ruta ni se ejecuta.
//
// Antes se mandaba aqui WHATSAPP_WEBHOOK_SECRET, que es otra credencial (la del
// parametro ?secret= de /api/whatsapp/incoming) y nunca coincidia: el bot
// respondia por WhatsApp y la sincronizacion moria en un 401.
async function syncOutgoingMessageToCRM({
  jid,
  phone,
  message,
  messageId,
  timestamp,
}) {
  const crmUrl = process.env.CRM_URL || "http://localhost:3000";
  const apiKey = process.env.INTERNAL_API_KEY;

  // Se corta antes de llamar al CRM y con el nombre de la variable en el
  // mensaje. Mandar la cabecera vacia daria un 401 igual, pero el log diria
  // solo "CRM respondio 401" y eso no apunta a nada.
  if (!apiKey) {
    throw new Error(
      "INTERNAL_API_KEY no esta configurado: el CRM rechazaria la sincronizacion con 401",
    );
  }

  const url = `${crmUrl}/api/whatsapp/outgoing`;

  const payload = {
    jid,
    phone,
    messageId,
    text: message,
    timestamp: new Date().toLocaleTimeString("es-PE", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
    sender: "agent",
    senderName: "Xiomara",
    channel: "whatsapp",
    source: "n8n",
    status: "sent",
  };

  console.log(
    "Sincronizando mensaje con CRM: hora registrada",
    payload.timestamp,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(`CRM respondió ${response.status}: ${errorText}`);
  }

  return await response.json();
}

/**
 * Envía mensaje genérico de texto (para CRM)
 */
export async function sendMessage(req, res) {
  try {
    if (!whatsappService.isReady) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp no está conectado",
      });
    }

    const { phone, jid: inputJid, message, source } = req.body;

    // Quien guarda el mensaje en el CRM.
    //
    // El CRM manda `source: "crm"` porque el ya escribio la burbuja en su
    // propia base ANTES de llamar aqui (page.tsx -> POST /api/messages);
    // sincronizarlo otra vez duplicaria el mensaje en el chat.
    //
    // Cualquier otro cliente -- n8n, un script -- no guarda nada en el CRM, asi
    // que lo sincronizamos nosotros. Antes la condicion era la contraria: solo
    // se sincronizaba si el body traia un campo `n8n`. Como ese campo lo pone a
    // mano el flujo de n8n, en cuanto se recreaba el nodo HTTP sin el, el bot
    // seguia contestando por WhatsApp y el CRM no se enteraba de nada. Ahora el
    // caso por defecto es sincronizar, y hay que pedir explicitamente lo otro.
    const esEnvioDelCRM = source === "crm";
    const debeSincronizarConCRM = !esEnvioDelCRM;

    if (!message) {
      return res.status(400).json({
        success: false,
        message: "El mensaje es obligatorio",
      });
    }

    let jid = null;

    // Si n8n/CRM ya conoce el JID real, lo preferimos.
    if (inputJid) {
      jid = await whatsappService.getJidForSending(inputJid);
    } else if (phone) {
      // LID
      if (String(phone).includes("@lid")) {
        jid = await whatsappService.getJidForSending(String(phone));
      } else {
        // Número telefónico
        const numberId = String(phone).replace(/\D/g, "");

        if (numberId.length < 10 || numberId.length > 15) {
          return res.status(400).json({
            success: false,
            message: "El formato del número de teléfono no es válido",
          });
        }

        jid = await whatsappService.getJidForSending(numberId);
      }
    } else {
      return res.status(400).json({
        success: false,
        message: "Se requiere jid o phone",
      });
    }

    if (!jid) {
      return res.status(404).json({
        success: false,
        message: "No se pudo resolver el destinatario de WhatsApp",
      });
    }

    // 1. Enviar primero a WhatsApp
    const result = await whatsappService.sendMessage(jid, message, {
      emitRealtime: debeSincronizarConCRM,
    });

    // 2. Solo después de enviar correctamente,
    //    sincronizamos el mensaje con el CRM.
    if (debeSincronizarConCRM) {
      try {
        await syncOutgoingMessageToCRM({
          jid,
          phone: phone || null,
          message,
          messageId: result.messageId,
          timestamp: result.timestamp,
        });
      } catch (crmError) {
        logger.error(
          "Mensaje de WhatsApp enviado, pero no se pudo sincronizar con CRM",
          {
            error: crmError.message,
            jid,
            messageId: result.messageId,
          },
        );
      }
    }

    return res.json(result);
  } catch (error) {
    logger.error("Error al enviar mensaje", {
      error: error.message,
    });

    return res.status(500).json({
      success: false,
      message: "Error al enviar el mensaje",
    });
  }
}

/**
 * Configura URL del webhook para mensajes entrantes
 */
export async function setupWebhook(req, res) {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "La URL del webhook es obligatoria",
      });
    }

    // Validar URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        success: false,
        message: "La URL del webhook no es válida",
      });
    }

    whatsappService.setWebhookUrl(url);

    res.json({
      success: true,
      message: "Webhook configurado correctamente",
      url: url,
    });
  } catch (error) {
    logger.error("Error al configurar webhook", { error: error.message });
    res.status(500).json({
      success: false,
      message: "Error al configurar el webhook",
    });
  }
}

/**
 * Obtiene mensajes recibidos recientes
 */
export async function getReceivedMessages(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = whatsappService.getReceivedMessages(limit);

    res.json({
      success: true,
      messages: messages,
      total: messages.length,
    });
  } catch (error) {
    logger.error("Error al obtener mensajes recibidos", {
      error: error.message,
    });
    res.status(500).json({
      success: false,
      message: "Error al obtener los mensajes",
    });
  }
}

/**
 * Envía mensaje con media (imagen, audio, video, documento)
 * POST /api/whatsapp/send-media
 * Body: { phone, type, media, caption?, filename?, mimetype? }
 */
export async function sendMedia(req, res) {
  try {
    if (!whatsappService.isReady) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp no está conectado",
      });
    }

    const {
      phone,
      type,
      media,
      caption,
      filename,
      mimetype: customMimetype,
    } = req.body;

    if (!phone || !type || !media) {
      return res.status(400).json({
        success: false,
        message:
          "El teléfono, tipo de media y el contenido del media son obligatorios",
      });
    }

    const allowedTypes = ["image", "audio", "video", "document", "sticker"];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: `Tipo de media no válido. Permitidos: ${allowedTypes.join(", ")}`,
      });
    }

    // Resolver JID
    let jid;
    if (phone.includes("@lid")) {
      jid = await whatsappService.getJidForSending(phone);
    } else {
      const numberId = phone.replace(/\D/g, "");
      if (numberId.length < 10 || numberId.length > 15) {
        return res.status(400).json({
          success: false,
          message: "El formato del número de teléfono no es válido",
        });
      }
      jid = await whatsappService.getJidForSending(numberId);
    }

    if (!jid) {
      return res.status(404).json({
        success: false,
        message: "El número no está registrado en WhatsApp",
      });
    }

    // Procesar el media
    const { buffer, mimetype: detectedMimetype } = await processMedia(media);
    if (!buffer) {
      return res.status(400).json({
        success: false,
        message: "No se pudo procesar el archivo de media",
      });
    }

    const finalMimetype = customMimetype || detectedMimetype;

    // Enviar según el tipo
    let result;
    switch (type) {
      case "image":
        result = await whatsappService.sendImage(
          jid,
          buffer,
          caption || "",
          finalMimetype,
        );
        break;
      case "audio":
        result = await whatsappService.sendAudio(
          jid,
          buffer,
          finalMimetype || "audio/mpeg; codecs=opus",
        );
        break;
      case "video":
        result = await whatsappService.sendVideo(
          jid,
          buffer,
          caption || "",
          finalMimetype || "video/mp4",
        );
        break;
      case "document":
        result = await whatsappService.sendDocument(
          jid,
          buffer,
          filename || "archivo",
          finalMimetype || "application/pdf",
        );
        break;
      case "sticker":
        result = await whatsappService.sendSticker(
          jid,
          buffer,
          finalMimetype || "image/webp",
        );
        break;
    }

    logger.info("Media enviado correctamente", { phone, type, jid });
    res.json(result);
  } catch (error) {
    logger.error("Error al enviar media", { error: error.message });
    res.status(500).json({
      success: false,
      message: "Error al enviar el archivo: " + error.message,
    });
  }
}
