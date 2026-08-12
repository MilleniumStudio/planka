/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

/**
 * @swagger
 * /boards/{id}/duplicate:
 *   post:
 *     summary: Duplicate board
 *     description: Creates a complete working copy of a board in the same project. Comments, activity history, subscriptions, and notification services are not copied. Board memberships, card memberships, and task assignments are preserved only when the actor is allowed to manage other users; otherwise, only the actor is added to the copy. Requires project manager permissions.
 *     tags:
 *       - Boards
 *     operationId: duplicateBoard
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: ID of the board to duplicate
 *         schema:
 *           type: string
 *           example: "1357158568008091264"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - position
 *             properties:
 *               position:
 *                 type: number
 *                 minimum: 0
 *                 description: Position of the duplicated board within the project
 *                 example: 131072
 *               name:
 *                 type: string
 *                 maxLength: 128
 *                 description: Name of the duplicated board. Defaults to the source name with a localized copy suffix.
 *                 example: Development Board (copy)
 *     responses:
 *       200:
 *         description: Board duplicated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required:
 *                 - item
 *                 - included
 *               properties:
 *                 item:
 *                   $ref: '#/components/schemas/Board'
 *                 included:
 *                   type: object
 *                   required:
 *                     - boardMemberships
 *                   properties:
 *                     boardMemberships:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/BoardMembership'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */

const { idInput } = require('../../../utils/inputs');

const Errors = {
  BOARD_NOT_FOUND: {
    boardNotFound: 'Board not found',
  },
};

module.exports = {
  inputs: {
    id: {
      ...idInput,
      required: true,
    },
    position: {
      type: 'number',
      min: 0,
      required: true,
    },
    name: {
      type: 'string',
      isNotEmptyString: true,
      maxLength: 128,
    },
  },

  exits: {
    boardNotFound: {
      responseType: 'notFound',
    },
  },

  async fn(inputs) {
    const { currentUser } = this.req;

    const { board: sourceBoard, project } = await sails.helpers.boards
      .getPathToProjectById(inputs.id)
      .intercept('pathNotFound', () => Errors.BOARD_NOT_FOUND);

    const isProjectManager = await sails.helpers.users.isProjectManager(currentUser.id, project.id);

    if (!isProjectManager) {
      throw Errors.BOARD_NOT_FOUND; // Forbidden
    }

    let { name } = inputs;
    if (_.isUndefined(name)) {
      const t = sails.helpers.utils.makeTranslator(currentUser.language);
      const suffix = ` (${t('copy')})`;
      name = `${sourceBoard.name.slice(0, Math.max(0, 128 - suffix.length))}${suffix}`.slice(
        0,
        128,
      );
    }

    const { board, boardMembership } = await sails.helpers.boards.duplicateOne.with({
      project,
      record: sourceBoard,
      values: {
        position: inputs.position,
        name,
      },
      actorUser: currentUser,
      cloneMemberships: sails.helpers.users.isAdminOrProjectOwner(currentUser),
      request: this.req,
    });

    if (!board) {
      throw Errors.BOARD_NOT_FOUND;
    }

    return {
      item: board,
      included: {
        boardMemberships: [boardMembership],
      },
    };
  },
};
