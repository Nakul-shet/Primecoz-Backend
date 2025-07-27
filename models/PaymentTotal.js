const mongoose = require('mongoose');

const paymentTotalSchema = new mongoose.Schema({
  totalAmount: {
    type: Number,
    required: true,
    default: 0
  }
});

module.exports = mongoose.model('PaymentTotal', paymentTotalSchema);