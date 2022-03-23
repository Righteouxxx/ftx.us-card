import { GenesisKeys, MasterNodeRegTestContainer } from '@defichain/testcontainers'
import { StubService } from '../stub.service'
import { StubWhaleApiClient } from '../stub.client'
import { WhaleApiClient } from '../../src'
import { TestingGroup } from '@defichain/jellyfish-testing'

let container: MasterNodeRegTestContainer
let service: StubService
let client: WhaleApiClient
let tGroup: TestingGroup

beforeAll(async () => {
  tGroup = TestingGroup.create(3)
  container = tGroup.group.get(0)
  service = new StubService(container)
  client = new StubWhaleApiClient(service)

  await tGroup.group.start()
  await service.start()
  await setup()
})

async function setMockTime (offsetHour: number): Promise<void> {
  await tGroup.exec(async (testing: any) => {
    await testing.misc.offsetTimeHourly(offsetHour)
  })
}

async function setup (): Promise<void> {
  {
    const auths = await tGroup.get(0).container.call('spv_listanchorauths')
    expect(auths.length).toStrictEqual(0)
  }

  const initOffsetHour = -12
  await setMockTime(initOffsetHour)

  for (let i = 0; i < 15; i += 1) {
    const { container } = tGroup.get(i % tGroup.length())
    await container.generate(1)
    await tGroup.waitForSync()
  }

  await tGroup.get(0).container.waitForAnchorTeams(tGroup.length())

  for (let i = 0; i < tGroup.length(); i += 1) {
    const { container } = tGroup.get(i % tGroup.length())
    const team = await container.call('getanchorteams')
    expect(team.auth.length).toStrictEqual(tGroup.length())
    expect(team.confirm.length).toStrictEqual(tGroup.length())
    expect(team.auth.includes(GenesisKeys[0].operator.address))
    expect(team.auth.includes(GenesisKeys[1].operator.address))
    expect(team.auth.includes(GenesisKeys[2].operator.address))
    expect(team.confirm.includes(GenesisKeys[0].operator.address))
    expect(team.confirm.includes(GenesisKeys[1].operator.address))
    expect(team.confirm.includes(GenesisKeys[2].operator.address))
  }

  await tGroup.anchor.generateAnchorAuths(2, initOffsetHour)

  await tGroup.get(0).container.waitForAnchorAuths(tGroup.length())

  for (let i = 0; i < tGroup.length(); i += 1) {
    const { container } = tGroup.get(i % tGroup.length())
    const auths = await container.call('spv_listanchorauths')
    expect(auths.length).toStrictEqual(2)
    expect(auths[0].signers).toStrictEqual(tGroup.length())
  }

  await tGroup.get(0).container.call('spv_setlastheight', [1])
  const anchor1 = await createAnchor()
  await tGroup.get(0).generate(1)
  await tGroup.waitForSync()

  await tGroup.get(0).container.call('spv_setlastheight', [2])
  const anchor2 = await createAnchor()
  await tGroup.get(0).generate(1)
  await tGroup.waitForSync()

  await tGroup.get(0).container.call('spv_setlastheight', [3])
  const anchor3 = await createAnchor()
  await tGroup.get(0).generate(1)
  await tGroup.waitForSync()

  await tGroup.get(0).container.call('spv_setlastheight', [4])
  const anchor4 = await createAnchor()
  await tGroup.get(0).generate(1)
  await tGroup.waitForSync()

  await tGroup.get(1).container.call('spv_sendrawtx', [anchor1.txHex])
  await tGroup.get(1).container.call('spv_sendrawtx', [anchor2.txHex])
  await tGroup.get(1).container.call('spv_sendrawtx', [anchor3.txHex])
  await tGroup.get(1).container.call('spv_sendrawtx', [anchor4.txHex])
  await tGroup.get(1).generate(1)
  await tGroup.waitForSync()

  await tGroup.get(0).container.call('spv_setlastheight', [6])
}

async function createAnchor (): Promise<any> {
  const rewardAddress = await tGroup.get(0).rpc.spv.getNewAddress()
  return await tGroup.get(0).rpc.spv.createAnchor([{
    txid: '11a276bb25585f6973a4dd68373cffff41dbcaddf12bbc1c2b489d1dc84564ee',
    vout: 2,
    amount: 15800,
    privkey: 'b0528d87cfdb09f72c9d10b7b3cc00727062d93537a3e8abcf1fde821d08b59d'
  }], rewardAddress)
}

afterAll(async () => {
  try {
    await service.stop()
  } finally {
    await tGroup.group.stop()
  }
})

describe('list', () => {
  it('should list anchors', async () => {
    const result = await client.anchors.list(4)
    expect(result[0]).toStrictEqual({
      id: '1',
      btc: {
        block: {
          height: 1,
          hash: '0000000000000001000000000000000100000000000000010000000000000001'
        },
        txn: {
          hash: expect.any(String)
        },
        confirmations: 6
      },
      dfi: {
        block: {
          height: 30,
          hash: expect.any(String)
        }
      },
      previousAnchor: '0000000000000000000000000000000000000000000000000000000000000000',
      rewardAddress: expect.any(String),
      signatures: 2,
      active: true,
      anchorCreationHeight: 75
    })
  })

  it('should test pagination', async () => {
    const first = await client.anchors.list(2)

    expect(first.length).toStrictEqual(2)
    expect(first.hasNext).toStrictEqual(true)
    expect(first.nextToken).toStrictEqual('3')

    expect(first[0]).toStrictEqual({
      id: '1',
      btc: {
        block: {
          height: 1,
          hash: '0000000000000001000000000000000100000000000000010000000000000001'
        },
        txn: {
          hash: expect.any(String)
        },
        confirmations: 6
      },
      dfi: {
        block: {
          height: 30,
          hash: expect.any(String)
        }
      },
      previousAnchor: '0000000000000000000000000000000000000000000000000000000000000000',
      rewardAddress: expect.any(String),
      signatures: 2,
      active: true,
      anchorCreationHeight: 75
    })

    const last = await client.anchors.list(3, first.nextToken)
    expect(last.length).toStrictEqual(2)
    expect(last.nextToken).toStrictEqual(undefined)

    expect(last[0]).toStrictEqual({
      id: '3',
      btc: {
        block: {
          height: 3,
          hash: '0000000000000001000000000000000100000000000000010000000000000001'
        },
        txn: {
          hash: expect.any(String)
        },
        confirmations: 4
      },
      dfi: {
        block: {
          height: 30,
          hash: expect.any(String)
        }
      },
      previousAnchor: '0000000000000000000000000000000000000000000000000000000000000000',
      rewardAddress: expect.any(String),
      signatures: 2,
      active: false,
      anchorCreationHeight: 75
    })
  })
})
