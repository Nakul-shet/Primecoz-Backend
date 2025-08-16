require('dotenv').config();
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');

const Member = require('./models/Member');
const PaymentTotal = require('./models/PaymentTotal');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const saltRounds = 10;

let client;
let qrCodeData = null;
let sessionPhone = null;
let sessionInfo = null;
let isInitializing = false;
let reconnectAttempts = 0;
let qrGeneratedTime = null;
let clientState = 'initializing';
let initializationTimeout = null;
const MAX_RECONNECT_ATTEMPTS = 5;
const QR_TIMEOUT = 60000;
const INITIALIZATION_TIMEOUT = 30000;
let sessionRestoredOnce = false;

const MONGO_URI = process.env.MONGODB_URL;

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionDir = path.join(__dirname, '.wwebjs_auth');
console.log('[WhatsApp] Starting with existing session data (if any)...');
console.log('[WhatsApp] Session directory path:', sessionDir);
console.log('[WhatsApp] Session directory exists:', fs.existsSync(sessionDir));
if (fs.existsSync(sessionDir)) {
  console.log('[WhatsApp] Session directory contents:', fs.readdirSync(sessionDir));
  const sessionMainPath = path.join(sessionDir, 'session-main');
  if (fs.existsSync(sessionMainPath)) {
    console.log('[WhatsApp] Session-main directory exists');
    const defaultPath = path.join(sessionMainPath, 'Default');
    if (fs.existsSync(defaultPath)) {
      console.log('[WhatsApp] Default session directory exists');
      const localStoragePath = path.join(defaultPath, 'Local Storage');
      if (fs.existsSync(localStoragePath)) {
        console.log('[WhatsApp] Local Storage directory exists - session data appears valid');
      }
    }
  }
}

function startClient() {
  if (isInitializing) {
    console.log('[WhatsApp] Client already initializing, skipping...');
    return;
  }
  
  // If client is in initializing state but not actually initializing, reset it
  if (clientState === 'initializing' && !isInitializing) {
    console.log('[WhatsApp] Client state is initializing but not actually initializing, resetting...');
    clientState = 'disconnected';
  }

  isInitializing = true;
  clientState = 'initializing';
  console.log('[WhatsApp] Starting client...');
  
  // Set initialization timeout
  initializationTimeout = setTimeout(() => {
    if (clientState === 'initializing') {
      console.error('[WhatsApp] Initialization timeout - client stuck in initializing state');
      isInitializing = false;
      clientState = 'error';
      if (client) {
        try {
          client.destroy();
        } catch (error) {
          console.log('[WhatsApp] Error destroying client:', error.message);
        }
      }
      // Restart client after timeout
      setTimeout(() => {
        console.log('[WhatsApp] Restarting client after timeout...');
        startClient();
      }, 5000);
    }
  }, INITIALIZATION_TIMEOUT);
  
  try {
    client = new Client({
      authStrategy: new LocalAuth({ 
        clientId: 'main',
        dataPath: sessionDir
      }),
      puppeteer: { 
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      }
    });

    client.on('qr', (qr) => {
      console.log('[WhatsApp] QR event received - clearing timeout');
      if (initializationTimeout) {
        clearTimeout(initializationTimeout);
        initializationTimeout = null;
      }
      
      qrCodeData = qr;
      qrGeneratedTime = Date.now();
      sessionPhone = null;
      sessionInfo = null;
      reconnectAttempts = 0;
      clientState = 'qr';
      isInitializing = false;

      console.log('[WhatsApp] QR code generated - scan this to authenticate:');
      
      // ✅ Print QR directly to terminal
      qrcodeTerminal.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
      console.log('[WhatsApp] Authenticated event received - clearing timeout');
      if (initializationTimeout) {
        clearTimeout(initializationTimeout);
        initializationTimeout = null;
      }
      console.log('[WhatsApp] Authenticated.');
      clientState = 'authenticated';
      // Don't clear QR immediately - let it timeout naturally
    });

    client.on('ready', async () => {
      console.log('[WhatsApp] Ready event received - clearing timeout');
      if (initializationTimeout) {
        clearTimeout(initializationTimeout);
        initializationTimeout = null;
      }
      console.log('[WhatsApp] Client is ready!');
      try {
        const info = await client.info;
        sessionPhone = info.wid.user;
        sessionInfo = info;
        reconnectAttempts = 0;
        isInitializing = false;
        clientState = 'ready';
        // Clear QR code only after client is fully ready
        qrCodeData = null;
        qrGeneratedTime = null;
        // Reset migration flag on successful connection
        sessionRestoredOnce = false;
        console.log(`[WhatsApp] Connected as ${sessionPhone}`);
      } catch (error) {
        console.error('[WhatsApp] Error getting client info:', error);
        isInitializing = false;
        clientState = 'error';
      }
    });

    client.on('disconnected', async (reason) => {
      console.log('[WhatsApp] Disconnected event received - clearing timeout');
      if (initializationTimeout) {
        clearTimeout(initializationTimeout);
        initializationTimeout = null;
      }
      console.log('[WhatsApp] Client disconnected:', reason);
      qrCodeData = null;
      qrGeneratedTime = null;
      sessionPhone = null;
      sessionInfo = null;
      isInitializing = false;
      clientState = 'disconnected';
      
      // Only attempt reconnection if it wasn't a manual logout
      if (reason !== 'NAVIGATION' && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`[WhatsApp] Attempting reconnection ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
        setTimeout(() => {
          startClient();
        }, 5000);
      } else {
        console.log('[WhatsApp] Max reconnection attempts reached or manual logout detected.');
      }
    });

    // --- Additional event logging for debugging ---
    client.on('auth_failure', (msg) => {
      console.log('[WhatsApp] Auth failure event received - clearing timeout');
      if (initializationTimeout) {
        clearTimeout(initializationTimeout);
        initializationTimeout = null;
      }
      console.error('[WhatsApp] Authentication failure:', msg);
      isInitializing = false;
      clientState = 'auth_failure';
      // Do not clear session directory here, just mark state
      qrCodeData = null;
      qrGeneratedTime = null;
      sessionPhone = null;
      sessionInfo = null;
    });

    client.on('change_state', (state) => {
      console.log('[WhatsApp] State changed:', state);
    });

    client.on('error', (err) => {
      console.log('[WhatsApp] Error event received - clearing timeout');
      if (initializationTimeout) {
        clearTimeout(initializationTimeout);
        initializationTimeout = null;
      }
      console.error('[WhatsApp] Client error:', err);
      isInitializing = false;
      clientState = 'error';
    });

    console.log('[WhatsApp] Calling client.initialize()...');
    client.initialize().catch((error) => {
      console.error('[WhatsApp] Error during client.initialize():', error);
      if (initializationTimeout) {
        clearTimeout(initializationTimeout);
        initializationTimeout = null;
      }
      isInitializing = false;
      clientState = 'error';
    });
  } catch (error) {
    console.error('[WhatsApp] Error creating client:', error);
    if (initializationTimeout) {
      clearTimeout(initializationTimeout);
      initializationTimeout = null;
    }
    isInitializing = false;
    clientState = 'error';
  }
}

// Check QR code timeout
setInterval(() => {
  if (qrCodeData && qrGeneratedTime && (Date.now() - qrGeneratedTime) > QR_TIMEOUT) {
    console.log('[WhatsApp] QR code expired, clearing...');
    qrCodeData = null;
    qrGeneratedTime = null;
  }
}, 10000); // Check every 10 seconds

startClient();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = './uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) and CSV files are allowed'));
    }
  }
});

const createTransporter = () => {
  return nodemailer.createTransport({
    service: 'gmail', 
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
};

const extractEmailsFromExcel = (filePath) => {
  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet);
    
    const emails = [];
    
    data.forEach((row, index) => {
      Object.keys(row).forEach(key => {
        const value = row[key];
        if (typeof value === 'string' && isValidEmail(value)) {
          emails.push({
            email: value.trim(),
            row: index + 1,
            column: key
          });
        }
      });
    });
    
    return emails;
  } catch (error) {
    throw new Error(`Error reading Excel file: ${error.message}`);
  }
};

const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const sendEmails = async (emails, subject, body) => {
  const transporter = createTransporter();
  const results = [];
  
  for (const emailData of emails) {
    try {
      const mailOptions = {
        from: `"Team Primecoz" <${process.env.EMAIL_USER}>`,
        to: emailData.email,
        subject: subject,
        html: body
      };

      const result = await transporter.sendMail(mailOptions);
      results.push({
        email: emailData.email,
        status: 'success',
        messageId: result.messageId
      });

      console.log(`Email sent successfully to ${emailData.email}`);
    } catch (error) {
      results.push({
        email: emailData.email,
        status: 'failed',
        error: error.message
      });
      console.error(`Failed to send email to ${emailData.email}:`, error.message);
    }
  }
  
  return results;
};

app.get('/', (req, res) => {
  res.json({
    message: 'Excel Email Sender API',
    endpoints: {
      'POST /upload': 'Upload Excel file and extract emails',
      'POST /send-emails': 'Send emails to extracted addresses'
    }
  });
});

app.post('/api/upload', upload.single('excelFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const filePath = req.file.path;
    const extractType = req.body.extractType || 'emails'; // Default to emails for backward compatibility
    
    let result;
    
    if (extractType === 'contacts') {
      // Extract contacts (names and phone numbers)
      const contacts = extractCandidatesFromExcel(filePath);
      
      if (contacts.length === 0) {
        fs.unlinkSync(filePath); // Clean up
        return res.status(400).json({ error: 'No valid contacts found in the Excel file. Make sure you have "Candidate Name" and "Telephone Number" columns.' });
      }
      
      result = {
        message: `Found ${contacts.length} contacts`,
        contacts: contacts,
        count: contacts.length
      };
    } else {
      // Extract emails (your existing logic)
      const emails = extractEmailsFromExcel(filePath);
      
      if (emails.length === 0) {
        fs.unlinkSync(filePath); // Clean up
        return res.status(400).json({ error: 'No valid email addresses found in the Excel file' });
      }
      
      result = {
        message: `Found ${emails.length} email addresses`,
        emails: emails
      };
    }
    
    // Clean up uploaded file
    fs.unlinkSync(filePath);
    
    res.json(result);
    
  } catch (error) {
    // Clean up file in case of error
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }
    res.status(500).json({ error: error.message });
  }
});

// app.post('/api/send-emails', async (req, res) => {
//   try {
//     const { emails, subject, body } = req.body;

//     body = body.replace(/\n/g, '<br>');

//     if (!emails || !Array.isArray(emails) || emails.length === 0) {
//       return res.status(400).json({ error: 'No email addresses provided' });
//     }
    
//     if (!subject || !body) {
//       return res.status(400).json({ error: 'Subject and body are required' });
//     }
    
//     const results = await sendEmails(emails, subject, body);
    
//     const successCount = results.filter(r => r.status === 'success').length;
//     const failedCount = results.filter(r => r.status === 'failed').length;
    
//     res.json({
//       message: `Email sending completed. ${successCount} sent, ${failedCount} failed`,
//       results: results
//     });
    
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// });

app.post('/api/send-emails', async (req, res) => {
  try {
    let { emails, subject, body } = req.body;

    // Ensure HTML line breaks
    // body = body.replace(/\n/g, '<br>');

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'No email addresses provided' });
    }
    
    if (!subject || !body) {
      return res.status(400).json({ error: 'Subject and body are required' });
    }

    // Batch + delay parameters
    const BATCH_SIZE = 20;         // Send 20 emails at a time
    const BATCH_DELAY_MS = 30000;   // Wait 30 seconds between batches

    const results = await sendEmailsInBatches(emails, subject, body, BATCH_SIZE, BATCH_DELAY_MS);

    const successCount = results.filter(r => r.status === 'success').length;
    const failedCount = results.filter(r => r.status === 'failed').length;
    
    res.json({
      message: `Email sending completed. ${successCount} sent, ${failedCount} failed`,
      results: results
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Sends all emails in batches with delay
const sendEmailsInBatches = async (emails, subject, body, batchSize, delayMs) => {
  let allResults = [];

  for (let i = 0; i < emails.length; i += batchSize) {
    const batch = emails.slice(i, i + batchSize);
    console.log(`📨 Sending batch ${Math.floor(i / batchSize) + 1} (${batch.length} emails)`);

    const batchResults = await sendEmails(batch, subject, body);
    allResults = allResults.concat(batchResults);

    // Delay only if there is another batch
    if (i + batchSize < emails.length) {
      console.log(`⏳ Waiting ${delayMs / 1000} seconds before next batch...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return allResults;
};

app.post('/api/extract-phone-numbers', upload.single('excelFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const data = extractCandidatesFromExcel(req.file.path);
    res.json({
      count: data.length,
      candidates: data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const extractCandidatesFromExcel = (filePath) => {
  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(worksheet);

    const results = [];

    rows.forEach((row, index) => {
      const name = row['Candidate Name'] ? String(row['Candidate Name']).trim() : null;
      const phone = row['Telephone Number'] ? String(row['Telephone Number']).trim() : null;

      if (name && phone && isValidPhoneNumber(phone)) {
        results.push({
          name,
          phone,
          row: index + 2 // +2 to account for header row in Excel
        });
      }
    });

    return results;

  } catch (error) {
    throw new Error(`Error reading Excel file: ${error.message}`);
  }
};

// Add your phone validation function if it's not already there
const isValidPhoneNumber = (number) => {
  const phoneRegex = /^\+?[0-9]{7,15}$/;
  return phoneRegex.test(number.replace(/\s+/g, ''));
};

app.post('/api/send-whatsapp', async (req, res) => {
  try {
    const { contacts, message } = req.body;
    
    const results = [];
    
    for (const contact of contacts) {
      try {
        // Replace {name} with actual contact name
        const personalizedMessage = message.replace(/{name}/g, contact.name);
        
        // Your WhatsApp API integration here
        // const result = await sendWhatsAppMessage(contact.phone, personalizedMessage);
        
        results.push({
          name: contact.name,
          phone: contact.phone,
          status: 'success',
          messageId: 'msg_123' // from WhatsApp API response
        });
      } catch (error) {
        results.push({
          name: contact.name,
          phone: contact.phone,
          status: 'failed',
          error: error.message
        });
      }
    }
    
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const qrcodeTerminal = require('qrcode-terminal');

app.get('/api/whatsapp/qr', async (req, res) => {
  console.log('[API] QR code requested. Current qrCodeData:', qrCodeData ? 'Available' : 'Not available');
  console.log('[API] Client status - isInitializing:', isInitializing, 'sessionInfo:', !!sessionInfo, 'clientState:', clientState);

  if (clientState === 'qr' && qrCodeData) {
    if (qrGeneratedTime && (Date.now() - qrGeneratedTime) > QR_TIMEOUT) {
      console.log('[WhatsApp] QR code has expired.');
      qrCodeData = null;
      qrGeneratedTime = null;
      return res.status(404).json({ error: 'QR code expired' });
    }

    try {
      // Print QR in terminal
      qrcodeTerminal.generate(qrCodeData, { small: true });
      
      // Still return it as Base64 for the frontend if needed
      const qrImage = await qrcode.toDataURL(qrCodeData);
      console.log('[API] QR image generated successfully, length:', qrImage.length);
      return res.json({ qr: qrImage });
    } catch (err) {
      console.error('[WhatsApp] Error generating QR image:', err);
      return res.status(500).json({ error: 'Failed to generate QR image' });
    }
  }

  if (clientState === 'ready') {
    return res.status(200).json({ message: 'Client is already authenticated and ready.' });
  }

  if (clientState === 'initializing' || isInitializing) {
    return res.status(202).json({ message: 'Client is initializing, please wait.' });
  }

  if ((clientState === 'disconnected' || clientState === 'auth_failure' || clientState === 'error') && !isInitializing) {
    console.log('[WhatsApp] Restarting client to recover from state:', clientState);
    startClient();
    return res.status(202).json({ message: 'Client is reconnecting, please wait.' });
  }

  return res.status(404).json({ error: 'No QR code available.' });
});

// Force generate QR code (reset session)
app.post('/api/whatsapp/qr', async (req, res) => {
  console.log('[API] Force QR generation requested.');
  try {
    // Clear any existing session
    if (client) {
      try {
        await client.logout();
      } catch (error) {
        console.log('[WhatsApp] Error during logout:', error.message);
      }
      // Force destroy the client
      try {
        await client.destroy();
      } catch (destroyError) {
        console.log('[WhatsApp] Error destroying client:', destroyError.message);
      }
    }
    
    // Clear session data
    qrCodeData = null;
    qrGeneratedTime = null;
    sessionPhone = null;
    sessionInfo = null;
    isInitializing = false;
    clientState = 'initializing';
    
    // Clear session directory
    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log('[WhatsApp] Session directory cleared.');
      } catch (error) {
        console.log('[WhatsApp] Error clearing session directory:', error.message);
      }
    }
    
    // Clear any existing timeout
    if (initializationTimeout) {
      clearTimeout(initializationTimeout);
      initializationTimeout = null;
    }
    
    // Restart client to generate new QR
    console.log('[WhatsApp] Restarting client to generate new QR code...');
    startClient();
    
    // Wait for QR generation
    let attempts = 0;
    const maxAttempts = 15; // Increased attempts
    const checkQR = () => {
      if (clientState === 'qr' && qrCodeData) {
        console.log('[WhatsApp] QR code generated successfully.');
        res.json({ success: true, message: 'QR code generated' });
      } else if (attempts < maxAttempts) {
        attempts++;
        console.log(`[WhatsApp] Waiting for QR code... attempt ${attempts}/${maxAttempts} (clientState: ${clientState})`);
        setTimeout(checkQR, 2000); // Increased wait time
      } else {
        console.log('[WhatsApp] Failed to generate QR code after multiple attempts.');
        res.status(500).json({ error: 'Failed to generate QR code' });
      }
    };
    setTimeout(checkQR, 2000); // Increased initial wait time
  } catch (error) {
    console.error('[WhatsApp] Error forcing QR generation:', error);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

app.post('/api/whatsapp/send', async (req, res) => {
  const { contacts, message } = req.body;
  console.log('[WhatsApp] Sending message to multiple contacts');

  if (!client || !sessionInfo) {
    console.log('[WhatsApp] Cannot send message: not connected.');
    return res.status(400).json({ error: 'No WhatsApp session' });
  }

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'No contacts provided' });
  }

  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  const results = [];

  // helper function to wait
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  for (const contact of contacts) {
    if (!contact.phone || !/^\d{10,15}$/.test(contact.phone)) {
      results.push({ contact, success: false, error: 'Invalid phone number format' });
      continue;
    }

    try {
      let number = "";
      if (!contact.phone.startsWith('91')) {
        number = `91${contact.phone}@c.us`;
      } else {
        number = `${contact.phone}@c.us`;
      }

      await client.sendMessage(number, message);
      console.log(`[WhatsApp] Message sent to ${contact.name || contact.phone}`);
      results.push({ contact, success: true });
    } catch (err) {
      console.error(`[WhatsApp] Error sending message to ${contact.phone}:`, err.message);
      results.push({ contact, success: false, error: err.message });
    }

    // wait 10 seconds before the next contact
    await delay(10000);
  }

  res.json({
    success: true,
    message: 'Message sending complete',
    results
  });
});

app.post('/api/upload-and-send', upload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const { subject, body } = req.body;
    
    if (!subject || !body) {
      return res.status(400).json({ error: 'Subject and body are required' });
    }
    
    const filePath = req.file.path;
    const emails = extractEmailsFromExcel(filePath);
    
    // Clean up uploaded file
    fs.unlinkSync(filePath);
    
    if (emails.length === 0) {
      return res.status(400).json({ error: 'No valid email addresses found in the Excel file' });
    }
    
    const results = await sendEmails(emails, subject, body);
    
    const successCount = results.filter(r => r.status === 'success').length;
    const failedCount = results.filter(r => r.status === 'failed').length;
    
    res.json({
      message: `Process completed. Found ${emails.length} emails. ${successCount} sent, ${failedCount} failed`,
      emailsFound: emails,
      results: results
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/test-email-config', async (req, res) => {
  try {
    const transporter = createTransporter();
    await transporter.verify();
    res.json({ message: 'Email configuration is valid' });
  } catch (error) {
    res.status(500).json({ error: 'Email configuration failed: ' + error.message });
  }
});

var currentAmount = 0;

app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, plan, user_email, user_name } = req.body;

    currentAmount = amount/100;

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const options = {
      amount: amount,
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
      notes: {
        plan: plan,
        user_email: user_email,
        user_name: user_name
      }
    };

    const order = await razorpay.orders.create(options);

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount
    });

  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { 
      razorpay_payment_id, 
      razorpay_order_id, 
      razorpay_signature,
      user_email,
      user_name,
      plan
    } = req.body;

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    const password = 'bpo' + Math.floor(100000 + Math.random() * 900000);
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const newMember = new Member({
      name: user_name,
      email: user_email,
      password: hashedPassword,
      plan: plan
    });

    try {
      await newMember.save();

      await PaymentTotal.findOneAndUpdate(
        {},
        { $inc: { totalAmount: currentAmount } },
        { upsert: true, new: true }
      );

      const credentials = {
        email : user_email,
        password : password
      }

      const emailSubject = `Welcome to PrimeCoz - Your Account Credentials`;
      
      try {
        await sendEmails([{email:user_email}] , emailSubject , generateHTMLEmail(user_name, credentials, plan))
        console.log(`Credentials email sent to ${user_email}`);

      } catch (emailError) {
        console.error('Email sending failed:', emailError);
      }

    } catch (err) {
      if (err.code === 11000) { // Duplicate email
        return res.status(400).json({ error: 'Email already exists' });
      }
      throw err;
    }

    res.json({
      success: true,
      credentials: {
        email: user_email,
        password: password
      }
    });

  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

app.post('/api/member-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  try {
    const user = await Member.findOne({ email });
    if (!user) {
      return res.json({ success: false, message: 'Invalid credentials' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.json({ success: false, message: 'Invalid credentials' });
    }
    res.json({ success: true, user: { name: user.name, email: user.email, plan: user.plan } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/payment-total', async (req, res) => {
  try {
    // Assuming you have only one document in PaymentTotal collection
    const totalDoc = await PaymentTotal.findOne();
    res.json({ totalAmount: totalDoc ? totalDoc.totalAmount : 0 });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch total amount' });
  }
});

app.get('/api/members', async (req, res) => {
  try {
    const members = await Member.find({}, '-password'); // Exclude password field
    res.json({ success: true, members });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

function generateHTMLEmail(userName, credentials, plan) {
  const loginUrl = process.env.FRONTEND_URL || 'https://primecoz.com/login';

  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.6;">
      <p>Hi ${userName},</p>

      <p>Welcome to <strong>PrimeCoz</strong>! 🎉</p>

      <p>Your payment for <strong>${plan}</strong> has been processed successfully, and your account is now ready.</p>

      <p><strong>LOGIN CREDENTIALS:</strong><br>
      Email: ${credentials.email}<br>
      Password: ${credentials.password}</p>

      <p>⚠️ <strong>IMPORTANT:</strong> Please save these credentials securely.</p>

      <p>
        <a href="${loginUrl}" style="color: #1a73e8;">Login here</a>
      </p>

      <p>What's next?</p>
      <ul>
        <li>Login to your account using the credentials above</li>
        <li>Start exploring your ${plan} features</li>
        <li>Access exclusive BPO resources and training materials</li>
      </ul>

      <p>If you have any questions, please contact our support team.</p>

      <p>Best regards,<br>
      The PrimeCoz Team</p>
    </div>
  `;
}

app.listen(PORT,'0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} for API documentation`);
});