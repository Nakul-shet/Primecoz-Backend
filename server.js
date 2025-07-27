require('dotenv').config();
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs');

const Member = require('./models/Member');
const PaymentTotal = require('./models/PaymentTotal');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const saltRounds = 10;

const MONGO_URI = process.env.MONGODB_URL;

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.post('/api/send-emails', async (req, res) => {
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

app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, plan, user_email, user_name } = req.body;

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
        { $inc: { totalAmount: amount } },
        { upsert: true, new: true }
      );

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

app.listen(PORT,'0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} for API documentation`);
});