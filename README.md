# Excel Email Sender

A Node.js application that reads Excel files and sends emails to all email addresses found in the spreadsheet.

## Features

- Upload Excel files (.xlsx, .xls) and CSV files
- Automatically detect and extract email addresses from any column
- Send customized emails to all extracted addresses
- REST API endpoints for integration with frontend applications
- Email validation and error handling
- Detailed reporting of email sending results

## Installation

1. Clone or download the project files
2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

4. Configure your email settings in `.env`:
```
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
PORT=3000
```

## Email Configuration

### Gmail Setup
1. Enable 2-factor authentication on your Gmail account
2. Generate an App Password:
   - Go to Google Account settings
   - Security → 2-Step Verification → App passwords
   - Generate a password for "Mail"
   - Use this password in your `.env` file

### Other Email Providers
Modify the transporter configuration in `server.js` for other email services:
```javascript
const transporter = nodemailer.createTransporter({
  host: 'smtp.your-provider.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});
```

## Usage

### Start the Server
```bash
npm start
# or for development with auto-restart
npm run dev
```

### Create Sample Excel File
```bash
node createSampleExcel.js
```

### API Endpoints

#### 1. Upload Excel File
```bash
POST /upload
```
Upload an Excel file and extract email addresses.

**Example using curl:**
```bash
curl -X POST -F "excelFile=@sample_contacts.xlsx" http://localhost:3000/upload
```

#### 2. Send Emails
```bash
POST /send-emails
```
Send emails to a list of addresses.

**Example using curl:**
```bash
curl -X POST http://localhost:3000/send-emails \
  -H "Content-Type: application/json" \
  -d '{
    "emails": [
      {"email": "john.doe@example.com"},
      {"email": "jane.smith@example.com"}
    ],
    "subject": "Test Email",
    "body": "<h1>Hello!</h1><p>This is a test email from our application.</p>"
  }'
```

#### 3. Upload and Send (Combined)
```bash
POST /upload-and-send
```
Upload Excel file and send emails in one request.

**Example using curl:**
```bash
curl -X POST \
  -F "excelFile=@sample_contacts.xlsx" \
  -F "subject=Welcome Email" \
  -F "body=<h1>Welcome!</h1><p>Thank you for joining us.</p>" \
  http://localhost:3000/upload-and-send
```

#### 4. Test Email Configuration
```bash
GET /test-email-config
```
Verify that email configuration is working.

## Frontend Integration

Here's a sample React component for uploading files:

```jsx
import React, { useState } from 'react';

const EmailSender = () => {
  const [file, setFile] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    
    const formData = new FormData();
    formData.append('excelFile', file);
    formData.append('subject', subject);
    formData.append('body', body);
    
    try {
      const response = await fetch('http://localhost:3000/upload-and-send', {
        method: 'POST',
        body: formData
      });
      
      const data = await response.json();
      setResult(data);
    } catch (error) {
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="file"
        accept=".xlsx,.xls,.csv"
        onChange={(e) => setFile(e.target.files[0])}
        required
      />
      <input
        type="text"
        placeholder="Subject"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        required
      />
      <textarea
        placeholder="Email body (HTML supported)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        required
      />
      <button type="submit" disabled={loading}>
        {loading ? 'Sending...' : 'Upload and Send Emails'}
      </button>
      
      {result && (
        <div>
          <h3>Results:</h3>
          <p>{result.message}</p>
        </div>
      )}
    </form>
  );
};

export default EmailSender;
```

## Excel File Format

The application will automatically detect email addresses in any column. Your Excel file can have any structure, but here's a recommended format:

| Name | Email | Company | Position |
|------|-------|---------|----------|
| John Doe | john.doe@example.com | Tech Corp | Developer |
| Jane Smith | jane.smith@example.com | Design Studio | Designer |

## Error Handling

The application includes comprehensive error handling:
- Invalid file formats
- Missing email addresses
- Email sending failures
- Invalid email addresses
- Network connectivity issues

## Security Notes

- Never commit your `.env` file to version control
- Use app passwords instead of regular passwords
- Consider implementing rate limiting for production use
- Validate and sanitize all inputs
- Consider implementing authentication for production deployment

## License

ISC License