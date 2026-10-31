import nodemailer from "nodemailer";

const clean = (value) => String(value || "").trim();
const address = (value) => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value);

function recipients(value) {
  const list = (Array.isArray(value) ? value : String(value || "").split(",")).map(clean).filter(Boolean);
  if (!list.length || list.some((email) => !address(email))) throw new Error("A valid email recipient is required.");
  return list;
}

/** Gmail/Workspace app passwords or another authenticated SMTP service. Never exposes credentials. */
export function createEmail({ env = process.env, transportFactory = nodemailer.createTransport } = {}) {
  const user = clean(env.SMTP_USER);
  const password = clean(env.SMTP_PASSWORD);
  const host = clean(env.SMTP_HOST) || "smtp.gmail.com";
  const port = Number(env.SMTP_PORT || 465);
  const from = clean(env.EMAIL_FROM) || user;
  const replyTo = clean(env.EMAIL_REPLY_TO) || from;
  const configured = Boolean(user && password && address(from) && address(replyTo) && [465, 587].includes(port));
  let transport;
  const getTransport = () => {
    if (!configured) throw new Error("Email delivery is not configured.");
    transport ??= transportFactory({
      host, port, secure: port === 465, requireTLS: true,
      auth: { user, pass: host === "smtp.gmail.com" ? password.replace(/\s/g, "") : password },
      connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 15_000,
      disableFileAccess: true, disableUrlAccess: true,
    });
    return transport;
  };
  return {
    configured,
    from,
    provider: host === "smtp.gmail.com" ? "Gmail" : "SMTP",
    async verify() { return getTransport().verify(); },
    async send({ to, cc, subject, html, text, messageId }) {
      const toList = recipients(to), ccList = cc ? recipients(cc) : [];
      const sent = await getTransport().sendMail({
        from: { name: clean(env.EMAIL_FROM_NAME) || "Dryer Vent Squad West Valley", address: from },
        replyTo, to: toList, ...(ccList.length ? { cc: ccList } : {}),
        subject: String(subject || "").replace(/[\r\n]+/g, " "), html, text,
        ...(messageId ? { messageId } : {}),
      });
      // SMTP acceptance is not a delivery receipt. A partial rejection also needs attention.
      if (sent.rejected?.length || !sent.accepted?.length) throw new Error("The email service did not accept every recipient.");
      return { messageId: sent.messageId || null };
    },
  };
}
