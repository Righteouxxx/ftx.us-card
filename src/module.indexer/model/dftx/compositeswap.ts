import { DfTxIndexer, DfTxTransaction } from '@src/module.indexer/model/dftx/_abstract'
import { CompositeSwap, CCompositeSwap } from '@defichain/jellyfish-transaction'
import { RawBlock } from '@src/module.indexer/model/_abstract'
import { Inject, Injectable } from '@nestjs/common'
import { PoolswapConsensusParams, PoolSwapIndexer } from './poolswap'
import { PoolPairMapper } from '@src/module.model/poolpair'
import { PoolPairTokenMapper } from '@src/module.model/poolpair.token'
import { NetworkName } from '@defichain/jellyfish-network'
import BigNumber from 'bignumber.js'
import { IndexerError } from '@src/module.indexer/error'

@Injectable()
export class CompositeSwapIndexer extends DfTxIndexer<CompositeSwap> {
  OP_CODE: number = CCompositeSwap.OP_CODE

  constructor (
    private readonly poolPairMapper: PoolPairMapper,
    private readonly poolPairTokenMapper: PoolPairTokenMapper,
    @Inject('NETWORK') protected readonly network: NetworkName
  ) {
    super()
  }

  async indexTransaction (block: RawBlock, transaction: DfTxTransaction<CompositeSwap>): Promise<void> {
    const data = transaction.dftx.data
    const poolSwap = data.poolSwap
    const poolIds = data.pools
    if (poolIds.length === 0) {
      const poolPairToken = await this.poolPairTokenMapper.queryForTokenPair(poolSwap.fromTokenId, poolSwap.toTokenId)

      if (poolPairToken === undefined) {
        throw new IndexerError(`Pool for pair ${poolSwap.fromTokenId}, ${poolSwap.toTokenId} not found`)
      }

      poolIds.push({ id: poolPairToken.poolPairId })
    }

    let previousAmount = { fromTokenId: -1, fromAmount: new BigNumber(0) }
    for (const pool of poolIds) {
      const poolPair = await this.poolPairMapper.getLatest(`${pool.id}`)

      let fromTokenId = poolSwap.fromTokenId
      let fromAmount = poolSwap.fromAmount

      if (previousAmount.fromTokenId !== -1) {
        fromTokenId = previousAmount.fromTokenId
        fromAmount = previousAmount.fromAmount
      }

      if (poolPair === undefined) {
        throw new IndexerError(`Pool with id ${pool.id} not found`)
      }

      const BayFrontGardensHeight = PoolswapConsensusParams[this.network].BayFrontGardensHeight
      const swappedPoolResults = PoolSwapIndexer.executeSwap(poolPair, fromTokenId, fromAmount,
        block.height > BayFrontGardensHeight)

      const swappedPoolpair = swappedPoolResults.poolPair
      swappedPoolpair.id = `${poolPair.poolPairId}-${block.height}`
      swappedPoolpair.block = { hash: block.hash, height: block.height, medianTime: block.mediantime, time: block.time }
      await this.poolPairMapper.put(swappedPoolpair)

      previousAmount = { fromAmount: swappedPoolResults.result.swapped, fromTokenId: swappedPoolResults.tokenOut }
    }
  }

  async invalidateTransaction (block: RawBlock, transaction: DfTxTransaction<CompositeSwap>): Promise<void> {
    const data = transaction.dftx.data
    const poolSwap = data.poolSwap
    const poolIds = data.pools
    if (poolIds.length === 0) {
      const poolPairToken = await this.poolPairTokenMapper.queryForTokenPair(poolSwap.fromTokenId, poolSwap.toTokenId)

      if (poolPairToken === undefined) {
        throw new IndexerError(`Pool for pair ${poolSwap.fromTokenId}, ${poolSwap.toTokenId} not found`)
      }

      poolIds.push({ id: poolPairToken.poolPairId })
    }

    for (const pool of poolIds) {
      await this.poolPairMapper.delete(`${pool.id}-${block.height}`)
    }
  }
}
