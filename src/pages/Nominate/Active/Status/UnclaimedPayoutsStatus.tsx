// Copyright 2023 @paritytech/polkadot-staking-dashboard authors & contributors
// SPDX-License-Identifier: GPL-3.0-only

import { planckToUnit } from '@polkadot-cloud/utils';
import { useTranslation } from 'react-i18next';
import { Stat } from 'library/Stat';
import { usePayouts } from 'contexts/Payouts';
import BigNumber from 'bignumber.js';
import { useApi } from 'contexts/Api';

export const UnclaimedPayoutsStatus = () => {
  const { t } = useTranslation('pages');
  const { network } = useApi();
  const { unclaimedPayouts } = usePayouts();

  const totalUnclaimed = Object.values(unclaimedPayouts || {}).reduce(
    (total, validators) =>
      Object.values(validators)
        .reduce((amount, value) => amount.plus(value), new BigNumber(0))
        .plus(total),
    new BigNumber(0)
  );

  return (
    <Stat
      label={t('nominate.pendingPayouts')}
      helpKey="Payout"
      stat={`${planckToUnit(totalUnclaimed, network.units)
        .decimalPlaces(4)
        .toFormat()} ${network.unit}
      `}
    />
  );
};
