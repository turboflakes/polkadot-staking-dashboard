// Copyright 2022 @paritytech/polkadot-staking-dashboard authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, forwardRef } from 'react';
import { useModal } from 'contexts/Modal';
import { useBalances } from 'contexts/Balances';
import { useApi } from 'contexts/Api';
import { useConnect } from 'contexts/Connect';
import { BondInputWithFeedback } from 'library/Form/BondInputWithFeedback';
import { useSubmitExtrinsic } from 'library/Hooks/useSubmitExtrinsic';
import { useStaking } from 'contexts/Staking';
import { planckBnToUnit } from 'Utils';
import { APIContextInterface } from 'types/api';
import { ConnectContextInterface } from 'types/connect';
import { usePools } from 'contexts/Pools';
import { ContentWrapper } from '../Wrappers';
import { NotesWrapper } from '../../Wrappers';
import { FormFooter } from './FormFooter';

export const UnbondSome = forwardRef((props: any, ref: any) => {
  const { setSection, task } = props;

  const { api, network } = useApi() as APIContextInterface;
  const { units } = network;
  const { setStatus: setModalStatus, setResize, config }: any = useModal();
  const { activeAccount } = useConnect() as ConnectContextInterface;
  const { staking, getControllerNotImported } = useStaking();
  const { getBondOptions, getBondedAccount, getAccountNominations }: any =
    useBalances();
  const { getPoolBondOptions, stats } = usePools();
  const { target } = config;
  const controller = getBondedAccount(activeAccount);
  const nominations = getAccountNominations(activeAccount);
  const controllerNotImported = getControllerNotImported(controller);
  const { minNominatorBond } = staking;
  const stakeBondOptions = getBondOptions(activeAccount);
  const poolBondOptions = getPoolBondOptions(activeAccount);
  const { minJoinBond } = stats;
  const isStaking = target === 'stake';
  const isPooling = target === 'pool';
  const isBondTask = task === 'bond_some' || task === 'bond_all';
  const isUnbondTask = task === 'unbond_some' || task === 'unbond_all';

  const { freeToBond } = isPooling ? poolBondOptions : stakeBondOptions;
  const { freeToUnbond } = isPooling ? poolBondOptions : stakeBondOptions;
  const { totalPossibleBond } = isPooling ? poolBondOptions : stakeBondOptions;

  // local bond value
  const [bond, setBond] = useState(freeToBond);

  // bond valid
  const [bondValid, setBondValid]: any = useState(false);

  // get the max amount available to unbond
  const freeToUnbondToMin = isPooling
    ? Math.max(freeToUnbond - planckBnToUnit(minJoinBond, units), 0)
    : Math.max(freeToUnbond - planckBnToUnit(minNominatorBond, units), 0);

  // unbond some validation
  const isValid = isPooling ? true : !controllerNotImported;

  // update bond value on task change
  useEffect(() => {
    const _bond = freeToUnbondToMin;
    setBond({ bond: _bond });

    setBondValid(isValid);
  }, [freeToUnbondToMin, isValid]);

  // modal resize on form update
  useEffect(() => {
    setResize();
  }, [bond]);

  // tx to submit
  const tx = () => {
    let _tx = null;
    if (!bondValid || !api || !activeAccount) {
      return _tx;
    }
    // stake unbond: controller must be imported
    if (isStaking && controllerNotImported) {
      return _tx;
    }
    // remove decimal errors
    const bondToSubmit = Math.floor(bond.bond * 10 ** units).toString();

    // determine _tx
    if (isPooling) {
      _tx = api.tx.nominationPools.unbond(activeAccount, bondToSubmit);
    } else if (isStaking) {
      _tx = api.tx.staking.unbond(bondToSubmit);
    }
    return _tx;
  };

  const { submitTx, estimatedFee, submitting }: any = useSubmitExtrinsic({
    tx: tx(),
    from: isPooling ? activeAccount : controller,
    shouldSubmit: bondValid,
    callbackSubmit: () => {
      setModalStatus(0);
    },
    callbackInBlock: () => {},
  });

  const TxFee = (
    <p>Estimated Tx Fee: {estimatedFee === null ? '...' : `${estimatedFee}`}</p>
  );

  return (
    <ContentWrapper ref={ref}>
      <div className="items">
        <>
          <BondInputWithFeedback
            target={target}
            unbond
            listenIsValid={setBondValid}
            defaultBond={freeToUnbondToMin}
            setters={[
              {
                set: setBond,
                current: bond,
              },
            ]}
          />
          <NotesWrapper>
            <p>
              Once unbonding, you must wait 28 days for your funds to become
              available.
            </p>
            {TxFee}
          </NotesWrapper>
        </>
      </div>
      <FormFooter
        setSection={setSection}
        submitTx={submitTx}
        submitting={submitting}
        isValid={bondValid}
      />
    </ContentWrapper>
  );
});
