const xlsx = require('xlsx');

// Sample data with emails
const sampleData = [
  {
    'Name': 'John Doe',
    'Email': 'nakulnshet1@gmail.com',
    'Company': 'Tech Corp',
    'Position': 'Developer'
  },
  {
    'Name': 'Jane Smith',
    'Email': 'shetnakul13@gmail.com',
    'Company': 'Design Studio',
    'Position': 'Designer'
  }
];

// Create workbook and worksheet
const workbook = xlsx.utils.book_new();
const worksheet = xlsx.utils.json_to_sheet(sampleData);

// Add worksheet to workbook
xlsx.utils.book_append_sheet(workbook, worksheet, 'Contacts');

// Write the file
xlsx.writeFile(workbook, 'sample_contacts.xlsx');

console.log('Sample Excel file created: sample_contacts.xlsx');
console.log('This file contains sample email addresses for testing.');
console.log('You can modify the data in this script to create your own test file.');