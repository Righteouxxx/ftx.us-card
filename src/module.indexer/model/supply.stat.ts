import { BurnHistory } from '@defichain/jellyfish-api-core/dist/category/account'
import { JsonRpcClient } from '@defichain/jellyfish-api-jsonrpc'
import { NetworkName } from '@defichain/jellyfish-network'
import { Inject, Injectable } from '@nestjs/common'
import { Indexer, RawBlock } from '@src/module.indexer/model/_abstract'
import { MasternodeStatsMapper } from '@src/module.model/masternode.stats'
import { SupplyStatMapper } from '@src/module.model/supply.stat'
import { SupplyStatAggregation, SupplyStatAggregationMapper } from '@src/module.model/supply.stat.aggregation'
import { HexEncoder } from '@src/module.model/_hex.encoder'
import BigNumber from 'bignumber.js'

type EmissionRateBound = 'GENESIS' | 'POST_GENESIS' | 'EUNOS'

@Injectable()
export class EmissionCalculator {
  constructor (
    private readonly network: NetworkName
  ) { }

  readonly EMISSION_RATES: { [key in EmissionRateBound]: (height: number) => number } = {
    GENESIS: _ => 591_000_030,
    POST_GENESIS: _ => 200, // AMK, BayFront, ClarkQuay, Dahkota: total DFI emission, doesnt matter emitting utxos or token
    EUNOS: (currentHeight: number) => {
      const eunosHeight = EmissionConsensusParams[this.network].EUNOS_HEIGHT
      if (currentHeight < eunosHeight) {
        throw new Error('Invalid emission rate calculation input')
      }

      if (currentHeight % 1 !== 0 || eunosHeight % 1 !== 0) {
        throw new Error('Invalid emission rate calculation input, block height must be whole number')
      }

      const params = EmissionConsensusParams[this.network]
      const reductionCount = Math.floor((currentHeight - eunosHeight) / params.EMISSION_REDUCTION_PERIOD)

      let subsidySatoshi = params.EUNOS_BASE_BLOCK_SUBSIDY_SATOSHI

      for (let i = 0; i < reductionCount; i++) {
        // no float/decimal operation
        const reduceAmount = subsidySatoshi * params.EMISSION_REDUCTION / BigInt(100_000)
        subsidySatoshi -= reduceAmount
      }

      return Number(subsidySatoshi) / 100_000_000
    }
  }

  calculate (height: number): number {
    const fork = this.getEmissionRateBound(height)
    return this.EMISSION_RATES[fork](height)
  }

  getEmissionRateBound (height: number): EmissionRateBound {
    if (height === 0) {
      return 'GENESIS'
    }

    const params = EmissionConsensusParams[this.network]
    if (height >= params.EUNOS_HEIGHT) {
      return 'EUNOS'
    }

    return 'POST_GENESIS'
  }
}

interface EmissionConsensusParamsI {
  PRE_EUNOS_BASE_BLOCK_SUBSIDY: number
  EUNOS_HEIGHT: number
  EUNOS_BASE_BLOCK_SUBSIDY_SATOSHI: bigint
  EMISSION_REDUCTION: bigint
  EMISSION_REDUCTION_PERIOD: number
}

const EmissionConsensusParams: { [key in NetworkName]: EmissionConsensusParamsI } = {
  mainnet: {
    EUNOS_HEIGHT: 894000,
    PRE_EUNOS_BASE_BLOCK_SUBSIDY: 200,
    EUNOS_BASE_BLOCK_SUBSIDY_SATOSHI: BigInt(40504000000),
    EMISSION_REDUCTION: BigInt(1658), // 1.658%, 10000x magnified, as int
    EMISSION_REDUCTION_PERIOD: 32690 // 2 weeks
  },
  testnet: {
    EUNOS_HEIGHT: 354950,
    PRE_EUNOS_BASE_BLOCK_SUBSIDY: 200,
    EUNOS_BASE_BLOCK_SUBSIDY_SATOSHI: BigInt(40504000000),
    EMISSION_REDUCTION: BigInt(1658), // 1.658%, 10000x magnified, as int
    EMISSION_REDUCTION_PERIOD: 32690 // 2 weeks
  },
  regtest: {
    EUNOS_HEIGHT: 50,
    PRE_EUNOS_BASE_BLOCK_SUBSIDY: 200,
    EUNOS_BASE_BLOCK_SUBSIDY_SATOSHI: BigInt(40504000000),
    EMISSION_REDUCTION: BigInt(1658), // 1.658%, 10000x magnified, as int
    EMISSION_REDUCTION_PERIOD: 5
  }
}

type SupplyStatData = Omit<SupplyStatAggregation, 'id' | 'block'>

@Injectable()
export class SupplyStatIndexer extends Indexer {
  private readonly emissionCalculator: EmissionCalculator

  constructor (
    private readonly mapper: SupplyStatMapper,
    private readonly aggregation: SupplyStatAggregationMapper,
    private readonly masternodeStats: MasternodeStatsMapper,
    private readonly rpc: JsonRpcClient,
    @Inject('NETWORK') protected readonly network: NetworkName
  ) {
    super()
    this.emissionCalculator = new EmissionCalculator(network)
  }

  async index (block: RawBlock): Promise<void> {
    const lastAggregated: SupplyStatData = block.height === 0
      ? {
          circulating: 0,
          burned: 0,
          locked: 0,
          total: 0
        }
      : (await this.aggregation.query(1, HexEncoder.encodeHeight(block.height)))[0]

    if (lastAggregated === undefined) {
      throw new Error(`Missing SupplyStatAggregation for block ${block.height - 1}`)
    }

    const currentBlockStat: SupplyStatData = {
      circulating: 0,
      burned: await this._calculateTotalBurned(block),
      locked: await this._calculateLockedMasternodeValue(block.height), // can be negative, MN timelock expires
      total: this.emissionCalculator.calculate(block.height)
    }

    currentBlockStat.circulating = new BigNumber(currentBlockStat.total)
      .minus(currentBlockStat.burned)
      .minus(currentBlockStat.locked)
      .dp(8)
      .toNumber()

    const encodedHeight = HexEncoder.encodeHeight(block.height)
    await this.mapper.put({
      id: encodedHeight,
      ...currentBlockStat,
      block: { hash: block.hash, height: block.height, time: block.time, medianTime: block.mediantime }
    })

    await this.aggregation.put({
      id: encodedHeight,
      circulating: new BigNumber(lastAggregated.circulating).plus(currentBlockStat.circulating).dp(8).toNumber(),
      burned: new BigNumber(lastAggregated.burned).plus(currentBlockStat.burned).dp(8).toNumber(),
      locked: new BigNumber(lastAggregated.locked).plus(currentBlockStat.locked).dp(8).toNumber(),
      total: new BigNumber(lastAggregated.total).plus(currentBlockStat.total).dp(8).toNumber(),
      block: { hash: block.hash, height: block.height, time: block.time, medianTime: block.mediantime }
    })
  }

  async invalidate (block: RawBlock): Promise<void> {
    const encodedHeight = HexEncoder.encodeHeight(block.height)
    await this.mapper.delete(encodedHeight)
    await this.aggregation.delete(encodedHeight)
  }

  private async _calculateTotalBurned (block: RawBlock): Promise<number> {
    let sum = new BigNumber(0)
    const burns = await this._extractBurnHistory(block)
    for (const burn of burns) {
      for (const amount of burn.amounts) {
        const [value, token] = amount.split('@')
        if (token === 'DFI') {
          const burnedAmt = new BigNumber(value)
          if (burnedAmt.isNaN()) {
            throw new Error('Invalid burn history')
          }
          sum = sum.plus(burnedAmt)
        }
      }
    }
    return sum.toNumber()
  }

  // TODO: extract by interpreting block data (another huge indexer) without relying on rpc
  private async _extractBurnHistory (block: RawBlock): Promise<BurnHistory[]> {
    return (await this.rpc.account.listBurnHistory({
      maxBlockHeight: block.height,
      depth: 1
    })).filter(b => b.blockHeight === block.height)
  }

  private async _calculateLockedMasternodeValue (height: number): Promise<number> {
    const thisBlockMnStat = await this.masternodeStats.get(height)
    if (thisBlockMnStat === undefined) {
      return 0
    }

    const currentTotalLocked = thisBlockMnStat.stats.locked
    const prevMnStats = (await this.masternodeStats.query(1, height))[0]?.stats.locked ?? []

    const currentLockedSum = currentTotalLocked.reduce((sum, tls) => (
      tls.weeks === 0 ? sum : sum.plus(tls.tvl)
    ), new BigNumber(0))
    const prevLockedSum = prevMnStats.reduce((sum, tls) => (
      tls.weeks === 0 ? sum : sum.plus(tls.tvl)
    ), new BigNumber(0))

    return currentLockedSum.minus(prevLockedSum).toNumber()
  }
}
