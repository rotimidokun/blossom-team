/**
 * Seed data for the mock vending API.
 * All made-up data (exercise ground rules: test keys and made-up data only).
 * Amounts are in kobo (NGN subunit), matching Paystack's convention: NGN 100 = 10000.
 */
import type { Db } from './types.js';

export function buildSeed(): Db {
  return {
    wallet: {
      currency: 'NGN',
      // Starts EMPTY on purpose: the first act of any demo is funding it,
      // which is the real sequence for a biller wallet (and shows the
      // insufficient-balance path without contriving it).
      balance: 0,
      low_balance_threshold: 500000, // NGN 5,000.00
      // Paystack's own documented test account (Zenith 0000000000) — using the
      // same test coordinates for the push-path biller and the pull-path
      // Paystack recipient keeps the demo internally consistent for reviewers.
      account_number: '0000000000',
      bank: 'Zenith Bank (test)'
    },
    meters: [
      {
        meter_number: '45123456789',
        disco: 'IKEDC',
        type: 'prepaid',
        owner_name: 'BLOSSOM BY TC LIMITED',
        available: true
      },
      {
        meter_number: '87654321098',
        disco: 'IKEDC',
        type: 'postpaid',
        owner_name: 'BLOSSOM BY TC LIMITED',
        available: true
      },
      {
        // Deliberately unavailable disco for the failure-path demo (field notes / recording).
        meter_number: '11223344556',
        disco: 'EKEDC',
        type: 'prepaid',
        owner_name: 'BLOSSOM BY TC LIMITED',
        available: false
      }
    ],
    phones: [
      { phone_number: '08031234567', network: 'MTN', valid: true },
      { phone_number: '08051234567', network: 'GLO', valid: true },
      { phone_number: '08091234567', network: 'AIRTEL', valid: true },
      { phone_number: '07000000000', network: null, valid: false }
    ],
    purchases: [],
    incoming: [], // recorded wallet credits (bank transfer or Paystack-funded)
    idempotency: {},
    designs: [], // Mae's approval queue: created -> pending -> approved/rejected
    orders: [], // Ada's sales pipeline: pending -> offer_sent -> paid / lead
    customers: [], // created when a payment verifies
    // The payroll: the three AI teammates ARE the staff (the owner is not on
    // payroll — owners draw, they don't take a salary; the demo flow is one
    // monthly batch run). Salaries are made-up monthly amounts in kobo. All
    // three point at the one test recipient (PAYSTACK_RECIPIENT) — per-staff
    // recipients are a go-live task; the transfer `reason` names the staff
    // member so the Paystack dashboard reads correctly.
    staff: [
      {
        id: 'stf_kemi',
        name: 'Kemi',
        role: 'HR / Admin / Operations',
        salary: 25000000, // NGN 250,000 / month
        agent: true,
        recipient_code: 'RCP_yab85z5ct7r24wg'
      },
      {
        id: 'stf_mae',
        name: 'Mae',
        role: 'Brands / Media',
        salary: 22000000, // NGN 220,000 / month
        agent: true,
        recipient_code: 'RCP_yab85z5ct7r24wg'
      },
      {
        id: 'stf_ada',
        name: 'Ada',
        role: 'Business Development / Sales',
        salary: 20000000, // NGN 200,000 / month
        agent: true,
        recipient_code: 'RCP_yab85z5ct7r24wg'
      }
    ],
    salaries: [], // salary attempts: paid (transfer ok) or failed (reason)
    generation_count: 0 // cost cap: how many images generated this session
  };
}
