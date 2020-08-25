// Copyright 2017-2020 @polkadot/app-calendar authors & contributors
// This software may be modified and distributed under the terms
// of the Apache-2.0 license. See the LICENSE file for details.

import { DeriveCollectiveProposal, DeriveDispatch, DeriveReferendumExt, DeriveSessionProgress } from '@polkadot/api-derive/types';
import { BlockNumber, EraIndex, Scheduled, UnappliedSlash } from '@polkadot/types/interfaces';
import { EntryInfo, EntryType } from './types';

import BN from 'bn.js';
import { useEffect, useState } from 'react';
import { useApi, useBlockTime, useCall } from '@polkadot/react-hooks';
import { Option } from '@polkadot/types';
import { BN_ONE } from '@polkadot/util';

interface DateExt {
  date: Date;
  dateTime: number;
}

type SlashEntry = [{ args: [EraIndex] }, UnappliedSlash[]];

type ScheduleEntry = [{ args: [BlockNumber] }, Option<Scheduled>[]];

function newDate (remaining: BN, blockTime: number): DateExt {
  const date = new Date(Date.now() + remaining.muln(blockTime).toNumber());

  return { date, dateTime: date.getTime() };
}

function createConstDurations (bestNumber: BlockNumber, blockTime: number, items: [EntryType, BlockNumber?][]): [EntryType, EntryInfo[]][] {
  return items.map(([type, duration]): [EntryType, EntryInfo[]] => {
    if (!duration) {
      return [type, []];
    }

    const blocks = duration.sub(bestNumber.mod(duration));

    return [type, [{
      ...newDate(blocks, blockTime),
      blockNumber: bestNumber.add(blocks),
      blocks,
      info: null,
      type
    }]];
  });
}

function createCouncilMotions (bestNumber: BlockNumber, blockTime: number, motions: DeriveCollectiveProposal[]): [EntryType, EntryInfo[]][] {
  return motions
    .map(({ hash, votes }): [EntryType, EntryInfo[]] | null => {
      if (!votes) {
        return null;
      }

      const hashStr = hash.toHex();
      const blocks = votes.end.sub(bestNumber);

      return ['councilMotion', [{
        ...newDate(blocks, blockTime),
        blockNumber: votes.end,
        blocks,
        info: `${hashStr.substr(0, 6)}…${hashStr.substr(-4)}`,
        type: 'councilMotion'
      }]];
    })
    .filter((item): item is [EntryType, EntryInfo[]] => !!item);
}

function createDispatches (bestNumber: BlockNumber, blockTime: number, dispatches: DeriveDispatch[]): [EntryType, EntryInfo[]][] {
  return dispatches.map(({ at, index }): [EntryType, EntryInfo[]] => {
    const blocks = at.sub(bestNumber);

    return ['democracyDispatch', [{
      ...newDate(blocks, blockTime),
      blockNumber: at,
      blocks,
      info: index,
      type: 'democracyDispatch'
    }]];
  });
}

function createReferendums (bestNumber: BlockNumber, blockTime: number, referendums: DeriveReferendumExt[]): [EntryType, EntryInfo[]][] {
  return referendums.reduce((result: [EntryType, EntryInfo[]][], { index, status }): [EntryType, EntryInfo[]][] => {
    const enactBlocks = status.end.add(status.delay).sub(bestNumber);
    const voteBlocks = status.end.sub(bestNumber).subn(1);

    result.push(['referendumVote', [{
      ...newDate(voteBlocks, blockTime),
      blockNumber: bestNumber.add(voteBlocks),
      blocks: voteBlocks,
      info: index,
      type: 'referendumVote'
    }]]);
    result.push(['referendumDispatch', [{
      ...newDate(enactBlocks, blockTime),
      blockNumber: bestNumber.add(enactBlocks),
      blocks: enactBlocks,
      info: index,
      isPending: true,
      type: 'referendumDispatch'
    }]]);

    return result;
  }, []);
}

function createStakingInfo (bestNumber: BlockNumber, blockTime: number, sessionInfo: DeriveSessionProgress, unapplied: SlashEntry[], slashDeferDuration?: BlockNumber): [EntryType, EntryInfo[]][] {
  const remainingEra = sessionInfo.eraLength.sub(sessionInfo.eraProgress);
  const remainingSes = sessionInfo.sessionLength.sub(sessionInfo.sessionProgress);
  const slashDuration = slashDeferDuration?.mul(sessionInfo.eraLength);
  const slashEras = slashDuration
    ? unapplied
      .filter(([, values]) => values.length)
      .map(([key]): EntryInfo => {
        const eraIndex = key.args[0];
        const blockProgress = sessionInfo.activeEra.sub(eraIndex).subn(1).mul(sessionInfo.eraLength).add(sessionInfo.eraProgress);
        const blocks = slashDuration.sub(blockProgress);

        return {
          ...newDate(blocks, blockTime),
          blockNumber: bestNumber.add(blocks),
          blocks,
          info: eraIndex,
          type: 'stakingSlash'
        };
      })
    : [];

  return [
    ['stakingEra', [{
      ...newDate(remainingEra, blockTime),
      blockNumber: bestNumber.add(remainingEra),
      blocks: remainingEra,
      info: sessionInfo.activeEra.add(BN_ONE),
      type: 'stakingEra'
    }]],
    ['stakingSession', [{
      ...newDate(remainingSes, blockTime),
      blockNumber: bestNumber.add(remainingSes),
      blocks: remainingSes,
      info: sessionInfo.currentIndex.add(BN_ONE),
      type: 'stakingSession'
    }]],
    ['stakingSlash', slashEras]
  ];
}

function createScheduled (bestNumber: BlockNumber, blockTime: number, scheduled: ScheduleEntry[]): [EntryType, EntryInfo[]][] {
  return [['scheduler', scheduled
    .filter(([, vecSchedOpt]) => vecSchedOpt.some((schedOpt) => schedOpt.isSome))
    .reduce((items: EntryInfo[], [key, vecSchedOpt]): EntryInfo[] => {
      const blockNumber = key.args[0];

      return vecSchedOpt
        .filter((schedOpt) => schedOpt.isSome)
        .map((schedOpt) => schedOpt.unwrap())
        .reduce((items: EntryInfo[], { maybeId }) => {
          const idOrNull = maybeId.unwrapOr(null);
          const blocks = blockNumber.sub(bestNumber);

          items.push({
            ...newDate(blocks, blockTime),
            blockNumber,
            blocks,
            info: idOrNull
              ? idOrNull.isAscii
                ? idOrNull.toUtf8()
                : idOrNull.toHex()
              : null,
            type: 'scheduler'
          });

          return items;
        }, items);
    }, [])]];
}

function addFiltered (state: EntryInfo[], types: [EntryType, EntryInfo[]][]): EntryInfo[] {
  return types.reduce((state: EntryInfo[], [typeFilter, items]): EntryInfo[] =>
    state.filter(({ type }) => type !== typeFilter).concat(...items), state
  );
}

// TODO council votes, tips closing
export default function useScheduled (): EntryInfo[] {
  const { api } = useApi();
  const [blockTime] = useBlockTime();
  const bestNumber = useCall<BlockNumber>(api.derive.chain.bestNumber);
  const councilMotions = useCall<DeriveCollectiveProposal[]>(api.derive.council?.proposals);
  const dispatches = useCall<DeriveDispatch[]>(api.derive.democracy?.dispatchQueue);
  const referendums = useCall<DeriveReferendumExt[]>(api.derive.democracy?.referendums);
  const scheduled = useCall<ScheduleEntry[]>(api.query.scheduler?.agenda.entries as any);
  const sessionInfo = useCall<DeriveSessionProgress>(api.query.staking && api.derive.session?.progress);
  const slashes = useCall<SlashEntry[]>(api.query.staking?.unappliedSlashes.entries as any);
  const [state, setState] = useState<EntryInfo[]>([]);

  useEffect((): void => {
    bestNumber && dispatches && setState((state) =>
      addFiltered(state, createDispatches(bestNumber, blockTime, dispatches))
    );
  }, [bestNumber, blockTime, dispatches]);

  useEffect((): void => {
    bestNumber && councilMotions && setState((state) =>
      addFiltered(state, createCouncilMotions(bestNumber, blockTime, councilMotions))
    );
  }, [bestNumber, blockTime, councilMotions]);

  useEffect((): void => {
    bestNumber && referendums && setState((state) =>
      addFiltered(state, createReferendums(bestNumber, blockTime, referendums))
    );
  }, [bestNumber, blockTime, referendums]);

  useEffect((): void => {
    bestNumber && scheduled && setState((state) =>
      addFiltered(state, createScheduled(bestNumber, blockTime, scheduled))
    );
  }, [bestNumber, blockTime, scheduled]);

  useEffect((): void => {
    bestNumber && sessionInfo?.sessionLength.gt(BN_ONE) && slashes && setState((state) =>
      addFiltered(state, createStakingInfo(bestNumber, blockTime, sessionInfo, slashes, api.consts.staking.slashDeferDuration))
    );
  }, [api, bestNumber, blockTime, sessionInfo, slashes]);

  useEffect((): void => {
    bestNumber && setState((state) =>
      addFiltered(state, createConstDurations(bestNumber, blockTime, [
        ['councilElection', (api.consts.elections || api.consts.electionsPhragmen)?.termDuration],
        ['democracyLaunch', api.consts.democracy?.launchPeriod],
        ['societyChallenge', api.consts.society?.challengePeriod],
        ['societyRotate', api.consts.society?.rotationPeriod],
        ['treasurySpend', api.consts.treasury?.spendPeriod]
      ]))
    );
  }, [api, bestNumber, blockTime]);

  return state;
}