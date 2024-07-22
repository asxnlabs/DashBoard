import { bus, BUS_EVENTS, ErrorHandler } from '@/helpers'
import { storeToRefs, useWeb3ProvidersStore } from '@/store'
import { type BigNumber, type Erc1967ProxyType } from '@/types'
import { useTimestamp } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, Ref, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

export const usePool = (poolId: Ref<number>) => {
  let _currentUserRewardUpdateIntervalId: Parameters<typeof clearInterval>[0]

  const route = useRoute()

  const currentUserReward = ref<BigNumber | null>(null)
  const dailyReward = ref<BigNumber | null>(null)
  const poolData = ref<Erc1967ProxyType.PoolData | null>(null)
  const userPoolData = ref<Erc1967ProxyType.UserData | null>(null)

  const isInitializing = ref(false)
  const isUserDataUpdating = ref(false)

  const currentTimestamp = computed<number>(
    () => currentTimestampMs.value / 1000,
  )

  const isClaimDisabled = computed<boolean>(() => {
    if (
      !poolData.value ||
      !currentUserReward.value ||
      currentUserReward.value.isZero()
    )
      return true

    return (
      currentTimestamp.value <=
      poolData.value.payoutStart.add(poolData.value.claimLockPeriod).toNumber()
    )
  })

  const isDepositDisabled = computed<boolean>(() => {
    if (!web3ProvidersStore.balances.depositToken) return true
    return web3ProvidersStore.balances.depositToken.isZero()
  })

  const isWithdrawDisabled = computed<boolean>(() => {
    if (
      !poolData.value ||
      !userPoolData.value ||
      userPoolData.value.deposited.isZero()
    )
      return true

    if (currentTimestamp.value < poolData.value.payoutStart.toNumber())
      return false

    return userPoolData.value.lastStake.isZero()
      ? currentTimestamp.value <=
          poolData.value.payoutStart
            .add(poolData.value.withdrawLockPeriod)
            .toNumber()
      : currentTimestamp.value <=
          userPoolData.value.lastStake
            .add(poolData.value.withdrawLockPeriodAfterStake)
            .toNumber()
  })

  const currentTimestampMs = useTimestamp()

  const web3ProvidersStore = useWeb3ProvidersStore()
  const { erc1967ProxyContract } = storeToRefs(web3ProvidersStore)

  const fetchCurrentUserReward = async (): Promise<BigNumber> => {
    if (!web3ProvidersStore.provider.selectedAddress)
      throw new Error('user address unavailable')

    return erc1967ProxyContract.value.providerBased.value.getCurrentUserReward(
      poolId.value,
      web3ProvidersStore.provider.selectedAddress,
    )
  }

  const getDailyReward = (): BigNumber => {
    if (!poolData.value) throw new Error('poolData unavailable')

    const payoutStartTimestamp = poolData.value.payoutStart.toNumber()

    if (currentTimestamp.value <= payoutStartTimestamp)
      return poolData.value.initialReward

    const intervalsCount = Math.floor(
      (currentTimestamp.value - payoutStartTimestamp) /
        poolData.value.decreaseInterval.toNumber(),
    )

    return poolData.value.initialReward.sub(
      poolData.value.rewardDecrease.mul(intervalsCount),
    )
  }

  const fetchPoolData = async (): Promise<Erc1967ProxyType.PoolData> => {
    const poolDataResponses = await Promise.all([
      erc1967ProxyContract.value.providerBased.value.poolsData(poolId.value),
      erc1967ProxyContract.value.providerBased.value.pools(poolId.value),
    ])

    return {
      claimLockPeriod: poolDataResponses[1].claimLockPeriod,
      decreaseInterval: poolDataResponses[1].decreaseInterval,
      initialReward: poolDataResponses[1].initialReward,
      isPublic: poolDataResponses[1].isPublic,
      lastUpdate: poolDataResponses[0].lastUpdate,
      minimalStake: poolDataResponses[1].minimalStake,
      rate: poolDataResponses[0].rate,
      payoutStart: poolDataResponses[1].payoutStart,
      rewardDecrease: poolDataResponses[1].rewardDecrease,
      totalDeposited: poolDataResponses[0].totalDeposited,
      withdrawLockPeriod: poolDataResponses[1].withdrawLockPeriod,
      withdrawLockPeriodAfterStake:
        poolDataResponses[1].withdrawLockPeriodAfterStake,
    }
  }

  const fetchUserPoolData = async (): Promise<Erc1967ProxyType.UserData> => {
    if (!web3ProvidersStore.provider.selectedAddress)
      throw new Error('user address unavailable')

    const response =
      await erc1967ProxyContract.value.providerBased.value.usersData(
        web3ProvidersStore.provider.selectedAddress,
        poolId.value,
      )

    return {
      lastStake: response.lastStake,
      deposited: response.deposited,
      rate: response.rate,
      pendingRewards: response.pendingRewards,
    }
  }

  const updateUserData = async (): Promise<void> => {
    isUserDataUpdating.value = true

    try {
      const [userDataResponse, currentUserRewardResponse] = await Promise.all([
        fetchUserPoolData(),
        fetchCurrentUserReward(),
      ])

      userPoolData.value = userDataResponse
      currentUserReward.value = currentUserRewardResponse
    } finally {
      isUserDataUpdating.value = false
    }
  }

  const init = async () => {
    isInitializing.value = true

    try {
      if (
        web3ProvidersStore.isConnected &&
        web3ProvidersStore.provider.selectedAddress
      ) {
        const [pooDataResponse] = await Promise.all([
          fetchPoolData(),
          updateUserData(),
        ])

        poolData.value = pooDataResponse
      } else {
        poolData.value = await fetchPoolData()
      }

      if (poolData.value) dailyReward.value = getDailyReward()
    } catch (error) {
      ErrorHandler.process(error)
    }

    isInitializing.value = false
  }

  const onChangeCurrentUserReward = async (): Promise<void> => {
    if (web3ProvidersStore.provider.selectedAddress) {
      try {
        currentUserReward.value = await fetchCurrentUserReward()
      } catch (error) {
        ErrorHandler.process(error)
      }
    }
  }

  const onChangePoolData = async (): Promise<void> => {
    try {
      if (web3ProvidersStore.provider.selectedAddress) {
        const [pooDataResponse] = await Promise.all([
          fetchPoolData(),
          updateUserData(),
        ])

        poolData.value = pooDataResponse
        return
      }

      poolData.value = await fetchPoolData()
    } catch (error) {
      ErrorHandler.process(error)
    }
  }

  watch(() => [poolId, web3ProvidersStore.dashboardInfo], init, { deep: true })

  watch(
    () => [
      web3ProvidersStore.provider.selectedAddress,
      web3ProvidersStore.isConnected,
      web3ProvidersStore.dashboardInfo,
    ],
    async () => {
      currentUserReward.value = null
      userPoolData.value = null

      if (
        (route.query.address || web3ProvidersStore.provider.selectedAddress) &&
        web3ProvidersStore.isConnected
      ) {
        try {
          await updateUserData()
        } catch (error) {
          ErrorHandler.process(error)
        }
      }
    },
  )

  onMounted(() => {
    init()
    bus.on(BUS_EVENTS.changedPoolData, onChangePoolData)
    bus.on(BUS_EVENTS.changedCurrentUserReward, onChangeCurrentUserReward)
    _currentUserRewardUpdateIntervalId = setInterval(async () => {
      if (
        !web3ProvidersStore.isConnected ||
        !web3ProvidersStore.provider.selectedAddress ||
        !web3ProvidersStore.isValidChain ||
        web3ProvidersStore.isAddingToken
      )
        return

      try {
        currentUserReward.value = await fetchCurrentUserReward()
      } catch (error) {
        ErrorHandler.process(error)
      }
    }, 30000)
  })

  onBeforeUnmount(() => {
    bus.off(BUS_EVENTS.changedPoolData, onChangePoolData)
    bus.off(BUS_EVENTS.changedCurrentUserReward, onChangeCurrentUserReward)
    clearInterval(_currentUserRewardUpdateIntervalId)
  })

  return {
    currentUserReward,
    dailyReward,
    poolData,
    userPoolData,

    isClaimDisabled,
    isDepositDisabled,
    isWithdrawDisabled,

    isInitializing,
    isUserDataUpdating,
  }
}
