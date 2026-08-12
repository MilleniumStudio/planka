/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

const defaultFind = (criteria, { sort = 'id' } = {}) => Board.find(criteria).sort(sort);

const BOARD_SETTING_KEYS = [
  'defaultView',
  'defaultCardType',
  'limitCardTypesToDefaultOne',
  'alwaysDisplayCardCreator',
  'displayCardAges',
  'expandTaskListsByDefault',
];

const createEachUsingConnection = (Model, arrayOfValues, db) => {
  if (arrayOfValues.length === 0) {
    return [];
  }

  return Model.createEach(arrayOfValues).fetch().usingConnection(db);
};

/* Query methods */

const createOne = (values, { user } = {}) =>
  sails.getDatastore().transaction(async (db) => {
    const board = await Board.create({ ...values })
      .fetch()
      .usingConnection(db);

    const boardMembership = await BoardMembership.create({
      projectId: board.projectId,
      boardId: board.id,
      userId: user.id,
      role: BoardMembership.Roles.EDITOR,
    })
      .fetch()
      .usingConnection(db);

    const lists = await List.createEach(
      [List.Types.ARCHIVE, List.Types.TRASH].map((type) => ({
        type,
        boardId: board.id,
      })),
    )
      .fetch()
      .usingConnection(db);

    return { board, boardMembership, lists };
  });

const duplicateOne = (record, values, { user, cloneMemberships = false, repositions = [] } = {}) =>
  sails.getDatastore().transaction(async (db) => {
    await sails
      .sendNativeQuery('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      .usingConnection(db);

    const sourceBoard = await Board.findOne({
      id: record.id,
      projectId: record.projectId,
    }).usingConnection(db);

    if (!sourceBoard) {
      return null;
    }

    const sourceBoardMemberships = await BoardMembership.find({
      boardId: sourceBoard.id,
    })
      .sort('id')
      .usingConnection(db);

    const sourceLabels = await Label.find({
      boardId: sourceBoard.id,
    })
      .sort(['position', 'id'])
      .usingConnection(db);

    const sourceLists = await List.find({
      boardId: sourceBoard.id,
    })
      .sort(['position', 'id'])
      .usingConnection(db);

    const sourceCards = await Card.find({
      boardId: sourceBoard.id,
    })
      .sort('id')
      .usingConnection(db);

    const sourceCardIds = sails.helpers.utils.mapRecords(sourceCards);

    const sourceCardMemberships =
      sourceCardIds.length > 0
        ? await CardMembership.find({ cardId: sourceCardIds }).sort('id').usingConnection(db)
        : [];

    const sourceCardLabels =
      sourceCardIds.length > 0
        ? await CardLabel.find({ cardId: sourceCardIds }).sort('id').usingConnection(db)
        : [];

    const sourceTaskLists =
      sourceCardIds.length > 0
        ? await TaskList.find({ cardId: sourceCardIds })
            .sort(['position', 'id'])
            .usingConnection(db)
        : [];

    const sourceTaskListIds = sails.helpers.utils.mapRecords(sourceTaskLists);
    const sourceTasks =
      sourceTaskListIds.length > 0
        ? await Task.find({ taskListId: sourceTaskListIds })
            .sort(['position', 'id'])
            .usingConnection(db)
        : [];

    const sourceAttachments =
      sourceCardIds.length > 0
        ? await Attachment.find({ cardId: sourceCardIds }).sort('id').usingConnection(db)
        : [];

    const customFieldGroupCriteria = [{ boardId: sourceBoard.id }];
    if (sourceCardIds.length > 0) {
      customFieldGroupCriteria.push({ cardId: sourceCardIds });
    }

    const sourceCustomFieldGroups = await CustomFieldGroup.find({
      or: customFieldGroupCriteria,
    })
      .sort(['position', 'id'])
      .usingConnection(db);

    const sourceCustomFieldGroupIds = sails.helpers.utils.mapRecords(sourceCustomFieldGroups);
    const sourceCustomFields =
      sourceCustomFieldGroupIds.length > 0
        ? await CustomField.find({
            customFieldGroupId: sourceCustomFieldGroupIds,
          })
            .sort(['position', 'id'])
            .usingConnection(db)
        : [];

    const sourceCustomFieldValues =
      sourceCardIds.length > 0
        ? await CustomFieldValue.find({ cardId: sourceCardIds }).sort('id').usingConnection(db)
        : [];

    const sourceBaseCustomFieldGroupIds = _.uniq(
      sourceCustomFieldGroups
        .map(({ baseCustomFieldGroupId }) => baseCustomFieldGroupId)
        .filter(Boolean),
    );

    const sourceCustomFieldValueFieldIds = _.uniq(
      sourceCustomFieldValues.map(({ customFieldId }) => customFieldId),
    );

    const sourceBaseCustomFields =
      sourceBaseCustomFieldGroupIds.length > 0 && sourceCustomFieldValueFieldIds.length > 0
        ? await CustomField.find({
            id: sourceCustomFieldValueFieldIds,
            baseCustomFieldGroupId: sourceBaseCustomFieldGroupIds,
          })
            .sort('id')
            .usingConnection(db)
        : [];

    const sourceCustomFieldGroupById = _.keyBy(sourceCustomFieldGroups, 'id');
    const sourceBaseCustomFieldById = _.keyBy(sourceBaseCustomFields, 'id');

    // eslint-disable-next-line no-restricted-syntax
    for (const reposition of repositions) {
      // eslint-disable-next-line no-await-in-loop
      await Board.updateOne({
        id: reposition.record.id,
        projectId: reposition.record.projectId,
      })
        .set({
          position: reposition.position,
        })
        .usingConnection(db);
    }

    const board = await Board.create({
      ..._.pick(sourceBoard, BOARD_SETTING_KEYS),
      ..._.pick(values, ['position', 'name']),
      projectId: sourceBoard.projectId,
    })
      .fetch()
      .usingConnection(db);

    const boardMembershipValuesByUserId = {};

    if (cloneMemberships) {
      sourceBoardMemberships.forEach((boardMembership) => {
        boardMembershipValuesByUserId[boardMembership.userId] = {
          ..._.pick(boardMembership, ['userId', 'role', 'canComment']),
          projectId: board.projectId,
          boardId: board.id,
        };
      });
    }

    boardMembershipValuesByUserId[user.id] = {
      projectId: board.projectId,
      boardId: board.id,
      userId: user.id,
      role: BoardMembership.Roles.EDITOR,
      canComment: null,
    };

    const boardMemberships = await createEachUsingConnection(
      BoardMembership,
      Object.values(boardMembershipValuesByUserId),
      db,
    );

    const boardMembership = boardMemberships.find(({ userId }) => userId === user.id);
    const boardMemberUserIdsSet = new Set(
      sails.helpers.utils.mapRecords(boardMemberships, 'userId'),
    );

    const generatedIdsTotal =
      sourceLabels.length +
      sourceLists.length +
      sourceCards.length +
      sourceTaskLists.length +
      sourceAttachments.length +
      sourceCustomFieldGroups.length +
      sourceCustomFields.length;

    let generatedIds = [];
    if (generatedIdsTotal > 0) {
      const queryResult = await sails
        .sendNativeQuery('SELECT next_id() AS id FROM generate_series(1, $1) ORDER BY id', [
          generatedIdsTotal,
        ])
        .usingConnection(db);

      generatedIds = sails.helpers.utils.mapRecords(queryResult.rows);
    }

    let generatedIdIndex = 0;
    const takeGeneratedId = () => {
      const id = generatedIds[generatedIdIndex];
      generatedIdIndex += 1;
      return id;
    };

    const nextLabelIdByLabelId = {};
    const nextLabelValues = sourceLabels.map((label) => {
      const id = takeGeneratedId();
      nextLabelIdByLabelId[label.id] = id;

      return {
        ..._.pick(label, ['position', 'name', 'color']),
        id,
        boardId: board.id,
      };
    });

    await createEachUsingConnection(Label, nextLabelValues, db);

    const nextListIdByListId = {};
    const nextListValues = sourceLists.map((list) => {
      const id = takeGeneratedId();
      nextListIdByListId[list.id] = id;

      return {
        ..._.pick(list, ['type', 'position', 'name', 'color']),
        id,
        boardId: board.id,
      };
    });

    await createEachUsingConnection(List, nextListValues, db);

    const duplicableSourceCards = sourceCards.filter(({ listId }) => nextListIdByListId[listId]);

    const nextCardIdByCardId = {};
    duplicableSourceCards.forEach((card) => {
      nextCardIdByCardId[card.id] = takeGeneratedId();
    });

    const listChangedAt = new Date().toISOString();
    const nextCardValues = duplicableSourceCards.map((card) => ({
      ..._.pick(card, [
        'type',
        'position',
        'name',
        'description',
        'dueDate',
        'isDueCompleted',
        'stopwatch',
        'isClosed',
      ]),
      id: nextCardIdByCardId[card.id],
      boardId: board.id,
      listId: nextListIdByListId[card.listId],
      creatorUserId: user.id,
      prevListId: card.prevListId ? nextListIdByListId[card.prevListId] || null : null,
      coverAttachmentId: null,
      commentsTotal: 0,
      listChangedAt,
    }));

    await createEachUsingConnection(Card, nextCardValues, db);

    const nextCardMembershipValues = sourceCardMemberships
      .filter(
        ({ cardId, userId }) => nextCardIdByCardId[cardId] && boardMemberUserIdsSet.has(userId),
      )
      .map((cardMembership) => ({
        cardId: nextCardIdByCardId[cardMembership.cardId],
        userId: cardMembership.userId,
      }));

    await createEachUsingConnection(CardMembership, nextCardMembershipValues, db);

    const nextCardLabelValues = sourceCardLabels
      .filter(({ cardId, labelId }) => nextCardIdByCardId[cardId] && nextLabelIdByLabelId[labelId])
      .map((cardLabel) => ({
        cardId: nextCardIdByCardId[cardLabel.cardId],
        labelId: nextLabelIdByLabelId[cardLabel.labelId],
      }));

    await createEachUsingConnection(CardLabel, nextCardLabelValues, db);

    const nextTaskListIdByTaskListId = {};
    const nextTaskListValues = sourceTaskLists
      .filter(({ cardId }) => nextCardIdByCardId[cardId])
      .map((taskList) => {
        const id = takeGeneratedId();
        nextTaskListIdByTaskListId[taskList.id] = id;

        return {
          ..._.pick(taskList, ['position', 'name', 'showOnFrontOfCard', 'hideCompletedTasks']),
          id,
          cardId: nextCardIdByCardId[taskList.cardId],
        };
      });

    await createEachUsingConnection(TaskList, nextTaskListValues, db);

    const nextTaskValues = sourceTasks
      .filter(({ taskListId }) => nextTaskListIdByTaskListId[taskListId])
      .map((task) => ({
        ..._.pick(task, ['position', 'name', 'isCompleted']),
        taskListId: nextTaskListIdByTaskListId[task.taskListId],
        linkedCardId: task.linkedCardId
          ? nextCardIdByCardId[task.linkedCardId] || task.linkedCardId
          : null,
        assigneeUserId: boardMemberUserIdsSet.has(task.assigneeUserId) ? task.assigneeUserId : null,
      }));

    await createEachUsingConnection(Task, nextTaskValues, db);

    const nextAttachmentIdByAttachmentId = {};
    const nextAttachmentValues = sourceAttachments
      .filter(({ cardId }) => nextCardIdByCardId[cardId])
      .map((attachment) => {
        const id = takeGeneratedId();
        nextAttachmentIdByAttachmentId[attachment.id] = id;

        return {
          ..._.pick(attachment, ['type', 'data', 'name']),
          id,
          cardId: nextCardIdByCardId[attachment.cardId],
          creatorUserId: user.id,
        };
      });

    const nextAttachments =
      nextAttachmentValues.length > 0
        ? await Attachment.qm.create(nextAttachmentValues, { db })
        : [];

    const nextAttachmentIdsSet = new Set(sails.helpers.utils.mapRecords(nextAttachments));

    // eslint-disable-next-line no-restricted-syntax
    for (const sourceCard of duplicableSourceCards) {
      const nextCoverAttachmentId = nextAttachmentIdByAttachmentId[sourceCard.coverAttachmentId];

      if (nextCoverAttachmentId && nextAttachmentIdsSet.has(nextCoverAttachmentId)) {
        // eslint-disable-next-line no-await-in-loop
        await Card.updateOne(nextCardIdByCardId[sourceCard.id])
          .set({
            coverAttachmentId: nextCoverAttachmentId,
          })
          .usingConnection(db);
      }
    }

    const nextCustomFieldGroupIdByCustomFieldGroupId = {};
    const nextCustomFieldGroupValues = sourceCustomFieldGroups
      .filter(
        (customFieldGroup) =>
          customFieldGroup.boardId === sourceBoard.id ||
          nextCardIdByCardId[customFieldGroup.cardId],
      )
      .map((customFieldGroup) => {
        const id = takeGeneratedId();
        nextCustomFieldGroupIdByCustomFieldGroupId[customFieldGroup.id] = id;

        const nextValues = {
          ..._.pick(customFieldGroup, ['position', 'name', 'baseCustomFieldGroupId']),
          id,
        };

        if (customFieldGroup.boardId === sourceBoard.id) {
          nextValues.boardId = board.id;
        } else {
          nextValues.cardId = nextCardIdByCardId[customFieldGroup.cardId];
        }

        return nextValues;
      });

    await createEachUsingConnection(CustomFieldGroup, nextCustomFieldGroupValues, db);

    const nextCustomFieldIdByCustomFieldId = {};
    const nextCustomFieldValues = sourceCustomFields
      .filter(
        ({ customFieldGroupId }) => nextCustomFieldGroupIdByCustomFieldGroupId[customFieldGroupId],
      )
      .map((customField) => {
        const id = takeGeneratedId();
        nextCustomFieldIdByCustomFieldId[customField.id] = id;

        return {
          ..._.pick(customField, ['position', 'name', 'showOnFrontOfCard']),
          id,
          customFieldGroupId:
            nextCustomFieldGroupIdByCustomFieldGroupId[customField.customFieldGroupId],
        };
      });

    await createEachUsingConnection(CustomField, nextCustomFieldValues, db);

    const nextCustomFieldValueValues = sourceCustomFieldValues
      .filter(({ cardId, customFieldGroupId, customFieldId }) => {
        if (
          !nextCardIdByCardId[cardId] ||
          !nextCustomFieldGroupIdByCustomFieldGroupId[customFieldGroupId]
        ) {
          return false;
        }

        if (nextCustomFieldIdByCustomFieldId[customFieldId]) {
          return true;
        }

        const sourceCustomFieldGroup = sourceCustomFieldGroupById[customFieldGroupId];
        const sourceBaseCustomField = sourceBaseCustomFieldById[customFieldId];

        return (
          sourceCustomFieldGroup &&
          sourceCustomFieldGroup.baseCustomFieldGroupId &&
          sourceBaseCustomField &&
          sourceBaseCustomField.baseCustomFieldGroupId ===
            sourceCustomFieldGroup.baseCustomFieldGroupId
        );
      })
      .map((customFieldValue) => ({
        content: customFieldValue.content,
        cardId: nextCardIdByCardId[customFieldValue.cardId],
        customFieldGroupId:
          nextCustomFieldGroupIdByCustomFieldGroupId[customFieldValue.customFieldGroupId],
        customFieldId:
          nextCustomFieldIdByCustomFieldId[customFieldValue.customFieldId] ||
          customFieldValue.customFieldId,
      }));

    await createEachUsingConnection(CustomFieldValue, nextCustomFieldValueValues, db);

    return {
      board,
      boardMembership,
      boardMemberships,
    };
  });

const getByIds = (ids, { exceptProjectIdOrIds } = {}) => {
  const criteria = {
    id: ids,
  };

  if (exceptProjectIdOrIds) {
    criteria.projectId = {
      '!=': exceptProjectIdOrIds,
    };
  }

  return defaultFind(criteria);
};

const getByProjectId = (projectId, { exceptIdOrIds, sort = ['position', 'id'] } = {}) => {
  const criteria = {
    projectId,
  };

  if (exceptIdOrIds) {
    criteria.id = {
      '!=': exceptIdOrIds,
    };
  }

  return defaultFind(criteria, { sort });
};

const getByProjectIds = (projectIds, { sort = ['position', 'id'] } = {}) =>
  defaultFind(
    {
      projectId: projectIds,
    },
    { sort },
  );

const getOneById = (id) => Board.findOne(id);

const updateOne = (criteria, values) => Board.updateOne(criteria).set({ ...values });

// eslint-disable-next-line no-underscore-dangle
const delete_ = (criteria) => Board.destroy(criteria).fetch();

const deleteOne = (criteria) => Board.destroyOne(criteria);

module.exports = {
  createOne,
  duplicateOne,
  getByIds,
  getByProjectId,
  getByProjectIds,
  getOneById,
  updateOne,
  deleteOne,
  delete: delete_,
};
