
// ===================================================
//  NellsBotBase
//  Creator : NellsBotBase
//  Updated : 13 September 2026
// ===================================================

const { jidNormalizedUser, getContentType, areJidsSameUser } = require("@itsliaaa/baileys")
const chalk = require('chalk')
const fs = require('fs')
const axios = require('axios')
const moment = require('moment-timezone')
const { sizeFormatter } = require('human-readable')

const unixTimestampSeconds = (date = new Date()) => Math.floor(date.getTime() / 1000)
exports.unixTimestampSeconds = unixTimestampSeconds

exports.generateMessageTag = (epoch) => {
  let tag = unixTimestampSeconds().toString()
  if (epoch) tag += '.--' + epoch
  return tag
}

exports.processTime = (timestamp, now) => {
  return moment.duration(now - moment(timestamp * 1000)).asSeconds()
}

exports.getRandom = (ext) => `${Math.floor(Math.random() * 10000)}${ext}`

exports.getBuffer = async (url, options = {}) => {
  try {
    const res = await axios({
      method: "get",
      url,
      headers: { 'DNT': 1, 'Upgrade-Insecure-Request': 1 },
      ...options,
      responseType: 'arraybuffer'
    })
    return res.data
  } catch (err) {
    return err
  }
}

exports.fetchJson = async (url, options = {}) => {
  try {
    const res = await axios({ method: 'GET', url, ...options })
    return res.data
  } catch (err) {
    return err
  }
}

exports.runtime = (seconds) => {
  seconds = Number(seconds);
  let d = Math.floor(seconds / (3600 * 24));
  let h = Math.floor((seconds % (3600 * 24)) / 3600);
  let m = Math.floor((seconds % 3600) / 60);
  let s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
};

exports.formatp = sizeFormatter({
  std: 'JEDEC',
  decimalPlaces: 2,
  keepTrailingZeroes: false,
  render: (literal, symbol) => `${literal} ${symbol}B`,
})

exports.parseMention = (text = '') =>
  [...text.matchAll(/@([0-9]{5,16})/g)].map(v => v[1] + '@s.whatsapp.net')

exports.getGroupAdmins = (participants = []) =>
  participants.filter(p => p.admin).map(p => p.id)


exports.sleep = async (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

exports.isUrl = (url) => {
    return url.match(new RegExp(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/, 'gi'))
}

exports.getTime = (format, date) => {
  if (date) {
    return moment(date).locale('id').format(format)
  } else {
    return moment.tz('Asia/Jakarta').locale('id').format(format)
  }
}

exports.sendGmail = async (senderEmail, message) => {
  try {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_PASS;
    if (!user || !pass) {
      console.warn('[MAIL] GMAIL_USER or GMAIL_PASS is not configured in .env. Skipping sendGmail.');
      return false;
    }
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user, pass }
    });

    const mailOptions = {
      from: user,
      to: process.env.GMAIL_DEST || user,
      subject: 'New Message from ' + senderEmail,
      html: message,
    };

    await transporter.sendMail(mailOptions);
    console.log('[MAIL] Message sent via Gmail successfully.');
    return true;
  } catch (error) {
    console.error('[MAIL] Error sending email:', error.message);
    return false;
  }
}

exports.tanggal = (numer) => {
	const myMonths = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
	const myDays = ['Minggu','Senin','Selasa','Rabu','Kamis','Jum’at','Sabtu']; 
	const tgl = new Date(numer);
	const day = tgl.getDate();
	const bulan = tgl.getMonth();
	const thisDay = myDays[tgl.getDay()];
	const year = tgl.getFullYear(); 
	return `${thisDay}, ${day} - ${myMonths[bulan]} - ${year}`;
}

exports.smsg = (Yuukey, m, _store) => {
  if (!m) return m;

  const decode = (jid) =>
    Yuukey.decodeJid?.(jid) || jidNormalizedUser(jid || '')

  if (m.key) {
    m.id = m.key.id
    m.chat = m.key.remoteJid
    m.fromMe = m.key.fromMe
    m.isGroup = m.chat.endsWith('@g.us')
    m.sender = decode(
      m.fromMe
        ? Yuukey.user?.id
        : m.key.participant || m.chat
    )
    if (m.isGroup) m.participant = decode(m.key.participant)
  }

  if (m.message) {
    m.mtype = getContentType(m.message)
    m.msg = m.message[m.mtype]
    m.text =
      m.msg?.text ||
      m.msg?.caption ||
      m.message.conversation ||
      ''

    let quoted = m.msg?.contextInfo?.quotedMessage
    if (quoted) {
      let type = getContentType(quoted)
      m.quoted = quoted[type]
      m.quoted.key = {
        remoteJid: m.chat,
        fromMe: areJidsSameUser(
          decode(m.msg.contextInfo.participant),
          decode(Yuukey.user?.id)
        ),
        id: m.msg.contextInfo.stanzaId,
        participant: decode(m.msg.contextInfo.participant)
      }
      m.quoted.sender = decode(m.msg.contextInfo.participant)
      m.quoted.text =
        m.quoted.text ||
        m.quoted.caption ||
        m.quoted.conversation ||
        ''
    }
  }

  m.reply = (text, chatId = m.chat, options = {}) =>
    Yuukey.sendMessage(chatId, { text }, { quoted: m, ...options })

  return m
}
if (process.env.NODE_ENV !== 'test') {
  const file = require.resolve(__filename);
  fs.watchFile(file, { interval: 5000 }, () => {
    fs.unwatchFile(file);
    console.log(chalk.redBright(`Update ${__filename}`));
    delete require.cache[file];
    require(file);
  });
}
