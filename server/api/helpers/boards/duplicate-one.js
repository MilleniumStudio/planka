/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

module.exports = {
  inputs: {
    record: {
      type: 'ref',
      required: true,
    },
    values: {
      type: 'ref',
      required: true,
    },
    project: {
      type: 'ref',
      required: true,
    },
    actorUser: {
      type: 'ref',
      required: true,
    },
    cloneMemberships: {
      type: 'boolean',
      defaultsTo: false,
    },
    request: {
      type: 'ref',
    },
  },

  async fn(inputs) {
    const scoper = sails.helpers.projects.makeScoper.with({
      record: inputs.project,
    });

    const boards = await Board.qm.getByProjectId(inputs.project.id);

    const { position, repositions } = sails.helpers.utils.insertToPositionables(
      inputs.values.position,
      boards,
    );

    const result = await Board.qm.duplicateOne(
      inputs.record,
      {
        ...inputs.values,
        position,
      },
      {
        user: inputs.actorUser,
        cloneMemberships: inputs.cloneMemberships,
        repositions,
      },
    );

    if (!result) {
      return {
        board: null,
        boardMembership: null,
      };
    }

    const { board, boardMembership, boardMemberships } = result;

    try {
      if (repositions.length > 0) {
        await scoper.getUserIdsWithFullProjectVisibility();
        const clonedScoper = scoper.clone();

        // eslint-disable-next-line no-restricted-syntax
        for (const reposition of repositions) {
          clonedScoper.replaceBoard(reposition.record);
          // eslint-disable-next-line no-await-in-loop
          const boardRelatedUserIds = await clonedScoper.getBoardRelatedUserIds();

          boardRelatedUserIds.forEach((userId) => {
            sails.sockets.broadcast(`user:${userId}`, 'boardUpdate', {
              item: {
                id: reposition.record.id,
                position: reposition.position,
              },
            });
          });

          // TODO: send webhooks
        }
      }

      scoper.board = board;
      scoper.boardMemberships = boardMemberships;

      const boardRelatedUserIds = await scoper.getBoardRelatedUserIds();

      boardRelatedUserIds.forEach((userId) => {
        sails.sockets.broadcast(
          `user:${userId}`,
          'boardCreate',
          {
            item: board,
            included: {
              boardMemberships: boardMemberships.filter(
                (nextBoardMembership) => nextBoardMembership.userId === userId,
              ),
            },
          },
          inputs.request,
        );
      });

      const webhooks = await Webhook.qm.getAll();

      sails.helpers.utils.sendWebhooks.with({
        webhooks,
        event: Webhook.Events.BOARD_CREATE,
        buildData: () => ({
          item: board,
          included: {
            projects: [inputs.project],
            boardMemberships,
          },
        }),
        user: inputs.actorUser,
      });
    } catch (error) {
      sails.log.error(`Failed to broadcast duplicated board ${board.id}: ${error.stack || error}`);
    }

    return {
      board,
      boardMembership,
    };
  },
};
