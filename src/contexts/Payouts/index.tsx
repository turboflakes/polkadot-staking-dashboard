// Copyright 2023 @paritytech/polkadot-staking-dashboard authors & contributors
// SPDX-License-Identifier: GPL-3.0-only

import React, { useState, useEffect, useRef } from 'react';
import { useStaking } from 'contexts/Staking';
import { useApi } from 'contexts/Api';
import type { AnyApi, AnyJson, Sync } from 'types';
import { useConnect } from 'contexts/Connect';
import { useEffectIgnoreInitial } from '@polkadot-cloud/react/hooks';
import { useNetworkMetrics } from 'contexts/Network';
import Worker from 'workers/stakers?worker';
import { rmCommas, setStateWithRef } from '@polkadot-cloud/utils';
import BigNumber from 'bignumber.js';
import { MaxSupportedPayoutEras, defaultPayoutsContext } from './defaults';
import type {
  LocalValidatorExposure,
  PayoutsContextInterface,
  UnclaimedPayouts,
} from './types';
import {
  getLocalEraExposure,
  hasLocalEraExposure,
  setLocalEraExposure,
  setLocalUnclaimedPayouts,
} from './Utils';

const worker = new Worker();

export const PayoutsProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const { api, network } = useApi();
  const { activeAccount } = useConnect();
  const { activeEra } = useNetworkMetrics();
  const { isNominating, fetchEraStakers } = useStaking();

  // Store active accont's payout state.
  const [unclaimedPayouts, setUnclaimedPayouts] =
    useState<UnclaimedPayouts>(null);

  // Track whether payouts have been fetched.
  const [payoutsSynced, setPayoutsSynced] = useState<Sync>('unsynced');
  const payoutsSyncedRef = useRef(payoutsSynced);

  // Calculate eras to check for pending payouts.
  const getErasInterval = () => {
    const startEra = activeEra?.index.minus(1) || new BigNumber(1);
    const endEra = BigNumber.max(
      startEra.minus(MaxSupportedPayoutEras).plus(1),
      1
    );
    return {
      startEra,
      endEra,
    };
  };

  // Determine whether to keep processing a next era, or move onto checking for pending payouts.
  const shouldContinueProcessing = (era: BigNumber, endEra: BigNumber) => {
    // If there are more exposures to process, check next era.
    if (new BigNumber(era).isGreaterThan(endEra))
      checkEra(new BigNumber(era).minus(1));
    // If all exposures have been processed, check for pending payouts.
    else if (new BigNumber(era).isEqualTo(endEra)) {
      checkPendingPayouts();
    }
  };

  // Fetch exposure data for an era, and pass the data to the worker to determine the validator the
  // active account was backing in that era.
  const checkEra = async (era: BigNumber) => {
    if (!activeAccount) return;

    // Bypass worker if local exposure data is available.
    if (hasLocalEraExposure(network.name, era.toString(), activeAccount)) {
      // Continue processing eras, or move onto reward processing.
      shouldContinueProcessing(era, getErasInterval().endEra);
    } else {
      const exposures = await fetchEraStakers(era.toString());
      worker.postMessage({
        task: 'processEraForExposure',
        era: String(era),
        who: activeAccount,
        networkName: network.name,
        exposures,
      });
    }
  };

  // Handle worker message on completed exposure check.
  worker.onmessage = (message: MessageEvent) => {
    if (message) {
      // ensure correct task received.
      const { data } = message;
      const { task } = data;
      if (task !== 'processEraForExposure') return;

      // Exit early if network or account conditions have changed.
      const { networkName, who } = data;
      if (networkName !== network.name || who !== activeAccount) return;
      const { era, exposedValidators } = data;
      const { endEra } = getErasInterval();

      // Store received era exposure data results in local storage.
      setLocalEraExposure(
        networkName,
        era,
        who,
        exposedValidators,
        endEra.toString()
      );

      // Continue processing eras, or move onto reward processing.
      shouldContinueProcessing(era, endEra);
    }
  };

  // Start pending payout process once exposure data is fetched.
  const checkPendingPayouts = async () => {
    if (!api || !activeAccount) return;

    // Loop eras and determine validator ledgers to fetch.
    const erasValidators = [];
    const { startEra, endEra } = getErasInterval();
    let erasToCheck: string[] = [];
    let currentEra = startEra;
    while (currentEra.isGreaterThanOrEqualTo(endEra)) {
      const validators = Object.keys(
        getLocalEraExposure(network.name, currentEra.toString(), activeAccount)
      );
      erasValidators.push(...validators);
      erasToCheck.push(currentEra.toString());
      currentEra = currentEra.minus(1);
    }

    // Ensure no validator duplicates.
    const uniqueValidators = [...new Set(erasValidators)];
    // Ensure `erasToCheck` is in order, highest first.
    erasToCheck = erasToCheck.sort((a: string, b: string) =>
      new BigNumber(b).minus(a).toNumber()
    );

    const validatorExposedEras = (validator: string) => {
      const exposedEras: string[] = [];
      for (const era of erasToCheck)
        if (
          Object.values(
            Object.keys(getLocalEraExposure(network.name, era, activeAccount))
          )?.[0] === validator
        )
          exposedEras.push(era);
      return exposedEras;
    };

    // Fetch controllers in order to query ledgers.
    const bondedResults =
      await api.query.staking.bonded.multi<AnyApi>(uniqueValidators);
    const validatorControllers: Record<string, string> = {};
    for (let i = 0; i < bondedResults.length; i++) {
      const ctlr = bondedResults[i].unwrapOr(null);
      if (ctlr) validatorControllers[uniqueValidators[i]] = ctlr;
    }

    // Fetch ledgers to determine which rewards have not yet been claimed.
    const ledgerResults = await api.query.staking.ledger.multi<AnyApi>(
      Object.values(validatorControllers)
    );
    const unclaimedRewards: Record<string, string[]> = {};
    for (const ledgerResult of ledgerResults) {
      const ledger = ledgerResult.unwrapOr(null)?.toHuman();
      if (ledger) {
        unclaimedRewards[ledger.stash] = ledger.claimedRewards
          .map((e: string) => rmCommas(e))
          .filter(
            (e: string) =>
              !erasToCheck.includes(e) &&
              new BigNumber(e).isLessThanOrEqualTo(startEra) &&
              new BigNumber(e).isGreaterThanOrEqualTo(endEra)
          )
          .filter((r: string) =>
            validatorExposedEras(ledger.stash).includes(r)
          );
      }
    }

    // Reformat unclaimed rewards to be era => validators[].
    const unclaimedByEra: Record<string, string[]> = {};
    erasToCheck.forEach((era) => {
      const eraValidators: string[] = [];
      Object.entries(unclaimedRewards).forEach(([validator, eras]) => {
        if (eras.includes(era.toString())) eraValidators.push(validator);
      });

      if (eraValidators.length > 0)
        unclaimedByEra[era.toString()] = eraValidators;
    });

    // Accumulate calls needed to fetch data to calculate rewards.
    const calls: AnyApi[] = [];
    currentEra = startEra;
    Object.entries(unclaimedByEra).forEach(([era, validators]) => {
      if (validators.length > 0) {
        const validatorPrefsCalls = validators.map((validator: AnyJson) =>
          api.query.staking.erasValidatorPrefs<AnyApi>(era, validator)
        );
        calls.push(
          Promise.all([
            api.query.staking.erasValidatorReward<AnyApi>(era),
            api.query.staking.erasRewardPoints<AnyApi>(era),
            ...validatorPrefsCalls,
          ])
        );
      }
      currentEra = currentEra.minus(1);
    });

    // Iterate calls and determine unclaimed payouts.
    currentEra = startEra;
    const unclaimed: UnclaimedPayouts = {};

    let i = 0;
    for (const [reward, points, ...prefs] of await Promise.all(calls)) {
      const thisEra = Object.keys(unclaimedByEra)[i];
      const eraTotalPayout = new BigNumber(rmCommas(reward.toHuman()));
      const eraRewardPoints = points.toHuman();
      const unclaimedValidators = unclaimedByEra[thisEra.toString()];

      let j = 0;
      for (const pref of prefs) {
        const eraValidatorPrefs = pref.toHuman();
        const commission = new BigNumber(
          eraValidatorPrefs.commission.replace(/%/g, '')
        ).multipliedBy(0.01);

        // Get validator from era exposure data. Falls back no null if it cannot be found.
        const validator = unclaimedValidators?.[j] || '';

        const localExposed: LocalValidatorExposure | null = getLocalEraExposure(
          network.name,
          thisEra.toString(),
          activeAccount
        )?.[validator];

        const staked = new BigNumber(localExposed?.staked || '0');
        const total = new BigNumber(localExposed?.total || '0');
        const isValidator = localExposed?.isValidator || false;

        // Calculate the validator's share of total era payout.
        const totalRewardPoints = new BigNumber(
          rmCommas(eraRewardPoints.total)
        );
        const validatorRewardPoints = new BigNumber(
          rmCommas(eraRewardPoints.individual?.[validator] || '0')
        );
        const avail = eraTotalPayout
          .multipliedBy(validatorRewardPoints)
          .dividedBy(totalRewardPoints);

        const valCut = commission.multipliedBy(avail);

        const unclaimedPayout = total.isZero()
          ? new BigNumber(0)
          : avail
              .minus(valCut)
              .multipliedBy(staked)
              .dividedBy(total)
              .plus(isValidator ? valCut : 0);

        unclaimed[thisEra.toString()] = {
          ...unclaimed[thisEra.toString()],
          [validator]: unclaimedPayout.toString(),
        };
        j++;
      }

      // This is not currently useful for preventing re-syncing. Need to know the eras that have
      // been claimed already and remove them from `erasToCheck`.
      setLocalUnclaimedPayouts(
        network.name,
        thisEra.toString(),
        activeAccount,
        unclaimed[thisEra.toString()],
        endEra.toString()
      );

      i++;
      currentEra = currentEra.minus(1);
    }

    setUnclaimedPayouts({
      ...unclaimedPayouts,
      ...unclaimed,
    });
    setStateWithRef('synced', setPayoutsSynced, payoutsSyncedRef);
  };

  // Fetch payouts if active account is nominating.
  useEffect(() => {
    if (
      isNominating() &&
      !activeEra.index.isZero() &&
      payoutsSyncedRef.current === 'unsynced'
    ) {
      payoutsSyncedRef.current = 'syncing';
      // Start checking eras for exposures, starting with the previous one.
      checkEra(activeEra.index.minus(1));
    }
  }, [isNominating(), activeEra]);

  // Clear payout state on network / active account change.
  useEffectIgnoreInitial(() => {
    if (unclaimedPayouts !== null) {
      setUnclaimedPayouts(null);
      setStateWithRef('unsynced', setPayoutsSynced, payoutsSyncedRef);
    }
  }, [network, activeAccount]);

  return (
    <PayoutsContext.Provider
      value={{ unclaimedPayouts, payoutsSynced: payoutsSyncedRef.current }}
    >
      {children}
    </PayoutsContext.Provider>
  );
};

export const PayoutsContext = React.createContext<PayoutsContextInterface>(
  defaultPayoutsContext
);

export const usePayouts = () => React.useContext(PayoutsContext);
