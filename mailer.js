const nodemailer = require("nodemailer");

function validateMailConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("mail 配置不能为空。");
  }

  if (!config.from || !config.password || !config.host) {
    throw new Error("mail 配置缺少 from、password 或 host。");
  }

  if (!Array.isArray(config.to) || config.to.length === 0) {
    throw new Error("mail.to 至少需要一个收件人邮箱。");
  }
}

async function sendMail(html, mailConfig, context = {}) {
  validateMailConfig(mailConfig);

  const transporter = nodemailer.createTransport({
    host: mailConfig.host,
    port: Number(mailConfig.port || 25),
    secure: Boolean(mailConfig.secure),
    auth: {
      user: mailConfig.from,
      pass: mailConfig.password,
    },
  });

  const subjectSuffix = context.routeLabel ? ` - ${context.routeLabel}` : "";

  await transporter.sendMail({
    from: `"${mailConfig.fromName || "发件人"}" <${mailConfig.from}>`,
    to: mailConfig.to.join(","),
    cc:
      Array.isArray(mailConfig.cc) && mailConfig.cc.length > 0
        ? mailConfig.cc.join(",")
        : undefined,
    subject: `${mailConfig.subject || "航班低价提醒"}${subjectSuffix}`,
    html,
  });
}

module.exports = {
  sendMail,
};
