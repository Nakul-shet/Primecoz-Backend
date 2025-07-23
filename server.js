const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads
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

// Email configuration
const createTransporter = () => {
  return nodemailer.createTransport({
    service: 'gmail', // You can change this to your email service
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
};

// Function to read Excel file and extract emails
const extractEmailsFromExcel = (filePath) => {
  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet);
    
    const emails = [];
    
    // Look for email addresses in all columns
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

// Email validation function
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Function to send emails
const sendEmails = async (emails, subject, body) => {
  const transporter = createTransporter();
  const results = [];
  
  for (const emailData of emails) {
    try {
      const mailOptions = {
        from: process.env.EMAIL_USER,
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

// Stripe integration
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || ''); // Replace with your secret key

// Payment endpoint
app.post('/create-payment-intent', async (req, res) => {
  const { amount } = req.body;
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Excel Email Sender API',
    endpoints: {
      'POST /upload': 'Upload Excel file and extract emails',
      'POST /send-emails': 'Send emails to extracted addresses'
    }
  });
});

// Upload and process Excel file
app.post('/upload', upload.single('excelFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const filePath = req.file.path;
    const emails = extractEmailsFromExcel(filePath);
    
    // Clean up uploaded file
    fs.unlinkSync(filePath);
    
    if (emails.length === 0) {
      return res.status(400).json({ error: 'No valid email addresses found in the Excel file' });
    }
    
    res.json({
      message: `Found ${emails.length} email addresses`,
      emails: emails
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send emails endpoint
app.post('/send-emails', async (req, res) => {
  try {
    const { emails, subject, body } = req.body;
    
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'No email addresses provided' });
    }
    
    if (!subject || !body) {
      return res.status(400).json({ error: 'Subject and body are required' });
    }
    
    const results = await sendEmails(emails, subject, body);
    
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

// Combined endpoint - upload and send emails in one request
app.post('/upload-and-send', upload.single('excelFile'), async (req, res) => {
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

// Test email configuration
app.get('/test-email-config', async (req, res) => {
  try {
    const transporter = createTransporter();
    await transporter.verify();
    res.json({ message: 'Email configuration is valid' });
  } catch (error) {
    res.status(500).json({ error: 'Email configuration failed: ' + error.message });
  }
});

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount } = req.body;
    
    // Create a PaymentIntent with the order amount and currency
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // amount in paise (33 INR = 3300 paise)
      currency: 'inr',
      automatic_payment_methods: {
        enabled: true,
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook endpoint for handling successful payments
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = 'whsec_XXXXXXXXXXXXXXXXXXXXXXXX'; // Replace with your webhook secret

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log('Payment succeeded:', paymentIntent.id);
      // Here you can add logic to create user account, send welcome email, etc.
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} for API documentation`);
});