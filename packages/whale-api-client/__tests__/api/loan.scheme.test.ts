import { StubWhaleApiClient } from '../stub.client'
import { StubService } from '../stub.service'
import { WhaleApiClient, WhaleApiException } from '../../src'
import BigNumber from 'bignumber.js'
import { Testing } from '@defichain/jellyfish-testing'
import { MasterNodeRegTestContainer } from '@defichain/testcontainers'

let container: MasterNodeRegTestContainer
let service: StubService
let client: WhaleApiClient

beforeAll(async () => {
  container = new MasterNodeRegTestContainer()
  service = new StubService(container)
  client = new StubWhaleApiClient(service)

  await container.start()
  await container.waitForWalletCoinbaseMaturity()
  await service.start()

  const testing = Testing.create(container)

  // Default scheme
  await testing.rpc.loan.createLoanScheme({
    minColRatio: 100,
    interestRate: new BigNumber(6.5),
    id: 'default'
  })
  await testing.generate(1)

  await testing.rpc.loan.createLoanScheme({
    minColRatio: 150,
    interestRate: new BigNumber(5.5),
    id: 'scheme1'
  })
  await testing.generate(1)

  await testing.rpc.loan.createLoanScheme({
    minColRatio: 200,
    interestRate: new BigNumber(4.5),
    id: 'scheme2'
  })
  await testing.generate(1)

  await testing.rpc.loan.createLoanScheme({
    minColRatio: 250,
    interestRate: new BigNumber(3.5),
    id: 'scheme3'
  })
  await testing.generate(1)

  const height: number = (await client.rpc.call('getblockcount', [], 'number'))
  await container.generate(1)
  await service.waitForIndexedHeight(height)
})

afterAll(async () => {
  try {
    await service.stop()
  } finally {
    await container.stop()
  }
})

describe('list', () => {
  it('should listScheme', async () => {
    const list = await client.loan.listScheme()
    expect(list.length).toStrictEqual(4)
    expect([...list]).toStrictEqual([
      {
        id: 'default',
        minColRatio: 100,
        interestRate: '6.5',
        sort: expect.any(String),
        default: true
      },
      {
        id: 'scheme1',
        minColRatio: 150,
        interestRate: '5.5',
        sort: expect.any(String),
        default: false
      },
      {
        id: 'scheme2',
        minColRatio: 200,
        interestRate: '4.5',
        sort: expect.any(String),
        default: false
      },

      {
        id: 'scheme3',
        minColRatio: 250,
        interestRate: '3.5',
        sort: expect.any(String),
        default: false
      }
    ])
  })

  it('should listScheme with pagination', async () => {
    const first = await client.loan.listScheme(2)

    expect(first.length).toStrictEqual(2)
    expect(first.hasNext).toStrictEqual(true)
    expect(typeof first.nextToken).toStrictEqual('string')

    expect(first[0].id).toStrictEqual('default')
    expect(first[1].id).toStrictEqual('scheme1')

    const next = await client.paginate(first)

    expect(next.length).toStrictEqual(2)
    expect(next.hasNext).toStrictEqual(true)
    expect(typeof next.nextToken).toStrictEqual('string')

    expect(next[0].id).toStrictEqual('scheme2')
    expect(next[1].id).toStrictEqual('scheme3')

    const last = await client.paginate(next)

    expect(last.length).toStrictEqual(0)
    expect(last.hasNext).toStrictEqual(false)
    expect(last.nextToken).toStrictEqual(undefined)
  })
})

describe('get', () => {
  it('should get scheme by scheme id', async () => {
    const data = await client.loan.getScheme('scheme1')
    expect(data).toStrictEqual({
      id: 'scheme1',
      sort: expect.any(String),
      minColRatio: 150,
      interestRate: '5.5',
      default: false
    })
  })

  it('should fail due to getting non-existent or malformed id', async () => {
    expect.assertions(4)
    try {
      await client.loan.getScheme('999')
    } catch (err) {
      if (err instanceof WhaleApiException) {
        expect(err).toBeInstanceOf(WhaleApiException)
        expect(err.error).toStrictEqual({
          code: 404,
          type: 'NotFound',
          at: expect.any(Number),
          message: 'Unable to find scheme',
          url: '/v0.0/regtest/loans/schemes/999'
        })
      }
    }

    try {
      await client.loan.getScheme('$*@')
    } catch (err) {
      if (err instanceof WhaleApiException) {
        expect(err).toBeInstanceOf(WhaleApiException)
        expect(err.error).toStrictEqual({
          code: 404,
          type: 'NotFound',
          at: expect.any(Number),
          message: 'Unable to find scheme',
          url: '/v0.0/regtest/loans/schemes/$*@'
        })
      }
    }
  })
})
