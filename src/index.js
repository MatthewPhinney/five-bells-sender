'use strict'

const co = require('co')
const request = require('superagent')
const transferUtils = require('./transferUtils')
const notaryUtils = require('./notaryUtils')
const conditionUtils = require('./conditionUtils')
const quoteUtils = require('./quoteUtils')

/**
 * Create and execute a transaction.
 *
 * @param {Object} params
 *
 * Required for both modes:
 * @param {URI} params.sourceAccount - Account URI
 * @param {URI} params.destinationAccount - Account URI
 *
 * Optional depending on ledger authentication method
 * @param {String} [params.sourcePassword] - Account password (basic-auth)
 * @param {String|Buffer} [params.sourceKey] - Account TLS Key (client-cert-auth)
 * @param {String|Buffer} [params.sourceCert] - Account TLS Certificate (client-cert-auth)
 *
 * Exactly one of the following:
 * @param {String} params.sourceAmount - Amount (a string, so as not to lose precision)
 * @param {String} params.destinationAmount - Amount
 *
 * Required for Atomic mode only:
 * @param {URI} params.notary - Notary URI (if provided, use Atomic mode)
 * @param {String} params.notaryPublicKey - Base64-encoded public key
 * @param {String} params.caseId - User-provided UUID for notary case
 *
 * Other:
 * @param {Object} params.destinationMemo - Memo to be included in the transfer credit of the recipient
 * @param {Object} params.sourceMemo - Memo to be included in the transfer debit coming from the sender's account
 * @param {Object} params.additionalInfo
 * @param {Condition} params.receiptCondition - Object, execution condition.
 *                                              If not provided, one will be generated.
 * @param {String|Buffer} [params.ca] - Optional TLS CA if not using default CA (optional for https requests)
 */
function sendPayment (params) {
  return findPath({
    sourceAccount: params.sourceAccount,
    destinationAccount: params.destinationAccount,
    sourceAmount: params.sourceAmount,
    destinationAmount: params.destinationAmount
  }).then((quote) => executePayment(quote, {
    sourceAccount: params.sourceAccount,
    sourcePassword: params.sourcePassword,
    sourceKey: params.sourceKey,
    sourceCert: params.sourceCert,
    destinationAccount: params.destinationAccount,
    notary: params.notary,
    notaryPublicKey: params.notaryPublicKey,
    caseId: params.caseId,
    destinationMemo: params.destinationMemo,
    sourceMemo: params.sourceMemo,
    additionalInfo: params.additionalInfo,
    receiptCondition: params.receiptCondition,
    ca: params.ca
  }))
}

/**
 * Execute a transaction.
 *
 * @param {Object[]} quote - The quoted payment path.
 * @param {Object} params
 *
 * Required for both modes:
 * @param {URI} params.sourceAccount - Account URI
 * @param {URI} params.destinationAccount
 *
 * Optional depending on ledger authentication method
 * @param {String} [params.sourcePassword] - Account password (basic-auth)
 * @param {String|Buffer} [params.sourceKey] - Account TLS Key (client-cert-auth)
 * @param {String|Buffer} [params.sourceCert] - Account TLS Certificate (client-cert-auth)
 *
 * Required for Atomic mode only:
 * @param {URI} params.notary - Notary URI (if provided, use Atomic mode)
 * @param {String} params.notaryPublicKey - Base64-encoded public key
 *
 * Other:
 * @param {Object} params.destinationMemo - Memo to be included in the transfer credit of the recipient
 * @param {Object} params.sourceMemo - Memo to be included in the transfer debit coming from the sender's account
 * @param {Object} [params.additionalInfo]
 * @param {String} params.receiptCondition - Condition describing the receipt
 * @param {String} [params.executionCondition] - Execution condition.
 *   If not provided, one will be generated.
 * @param {String} [params.cancellationCondition] - Object, cancellation condition.
 *   If not provided, one will be generated.
 * @param {String} [params.caseId] = A notary case ID - if not provided, one will be generated
 * @param {String|Buffer} [params.ca] - Optional TLS CA if not using default CA (optional for https requests)
 */
function executePayment (quote, params) {
  return co(function * () {
    const isAtomic = !!params.notary
    if (isAtomic && !params.notaryPublicKey) {
      throw new Error('Missing required parameter: notaryPublicKey')
    }

    let sourceTransfer = transferUtils.setupTransfers(quote, params.additionalInfo)

    if (params.destinationMemo) {
      getDestinationTransfer(sourceTransfer).credits[0].memo = params.destinationMemo
    }
    if (params.sourceMemo) {
      sourceTransfer.debits[0].memo = params.sourceMemo
    }

    // In universal mode, all transfers are prepared. Then the recipient
    // executes the transfer on the final ledger by providing a receipt. This
    // then triggers a chain of executions back to the sender.
    //
    // In atomic mode, all transfers execute when the notary receives the
    // receipt and notifies the ledgers that it was received on time.
    const receiptCondition = params.receiptCondition

    // TODO: We could use optimistic mode if no receipt condition was specified.
    if (!receiptCondition) {
      throw new Error('Missing required parameter: receiptCondition')
    }

    const caseId = isAtomic && (yield notaryUtils.setupCase({
      notary: params.notary,
      caseId: params.caseID || params.caseId,
      receiptCondition: receiptCondition,
      transfers: [sourceTransfer, getDestinationTransfer(sourceTransfer)],
      expiresAt: transferUtils.transferExpiresAt(Date.now(), sourceTransfer)
    }))

    const conditionParams = {
      receiptCondition: receiptCondition,
      caseId,
      notary: params.notary,
      notaryPublicKey: params.notaryPublicKey
    }

    const executionCondition = params.executionCondition || conditionUtils.getExecutionCondition(conditionParams)
    const cancellationCondition = isAtomic && (params.cancellationCondition || conditionUtils.getCancellationCondition(conditionParams))

    sourceTransfer = transferUtils.setupConditions(sourceTransfer, {
      isAtomic,
      executionCondition,
      cancellationCondition,
      caseId
    })

    // Prepare the first transfer.
    const sourceUsername = (yield getAccount(params.sourceAccount)).name
    sourceTransfer.state = yield transferUtils.postTransfer(sourceTransfer, {
      username: sourceUsername,
      password: params.sourcePassword,
      key: params.sourceKey,
      cert: params.sourceCert,
      ca: params.ca
    })

    return sourceTransfer
  })
}

// /////////////////////////////////////////////////////////////////////////////
// Quoting
// /////////////////////////////////////////////////////////////////////////////

/**
 * @param {Object} params
 * @param {String} params.sourceAccount
 * @param {String} params.destinationAccount
 * @param {Number} params.destinationExpiryDuration
 * @param {Number} params.sourceExpiryDuration
 * Exactly one of the following:
 * @param {String} params.sourceAmount
 * @param {String} params.destinationAmount
 * @returns {Promise<Transfer>}
 */
function findPath (params) {
  return co(function * () {
    const sourceLedger = yield getAccountLedger(params.sourceAccount)
    const connectorAccounts = yield getLedgerConnectors(sourceLedger)
    const paths = yield connectorAccounts.map(function (connectorAccount) {
      return quoteUtils.getQuoteFromConnector(connectorAccount.connector, params)
    })
    if (!paths.length) return
    return paths.reduce(quoteUtils.getCheaperQuote)
  })
}

/**
 * @param {URI} account
 * @returns {Promise<Account>}
 */
function getAccount (account) {
  return co(function * () {
    const res = yield request.get(account)
    if (res.statusCode !== 200) {
      throw new Error('Unable to identify ledger from account: ' + account)
    }
    return res.body
  })
}

/**
 * @param {URI} account
 * @returns {Promise<URI>}
 */
function getAccountLedger (account) {
  return getAccount(account).then(account => account.ledger)
}

/**
 * @param {URI} ledger
 * @returns {Promise<Object[]>}
 */
function getLedgerConnectors (ledger) {
  return co(function * () {
    const res = yield request.get(ledger + '/connectors')
    return res.body
  })
}

/**
 * @param {Transfer} transfer
 * @returns {Transfer}
 */
function getDestinationTransfer (transfer) {
  return transfer.credits[0].memo.destination_transfer
}

module.exports = sendPayment
module.exports.default = sendPayment
module.exports.executePayment = executePayment
module.exports.findPath = findPath
