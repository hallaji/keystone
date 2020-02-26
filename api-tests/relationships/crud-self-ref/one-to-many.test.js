const { gen, sampleOne } = require('testcheck');
const { Text, Relationship } = require('@keystonejs/fields');
const cuid = require('cuid');
const { multiAdapterRunners, setupServer, graphqlRequest } = require('@keystonejs/test-utils');

const alphanumGenerator = gen.alphaNumString.notEmpty();

jest.setTimeout(6000000);

const createInitialData = async keystone => {
  const { data } = await graphqlRequest({
    keystone,
    query: `
mutation {
  createUsers(data: [{ data: { name: "${sampleOne(
    alphanumGenerator
  )}" } }, { data: { name: "${sampleOne(alphanumGenerator)}" } }, { data: { name: "${sampleOne(
      alphanumGenerator
    )}" } }]) { id }
}
`,
  });
  return { users: data.createUsers };
};

const createUserAndFriend = async keystone => {
  const {
    data: { createUser },
  } = await graphqlRequest({
    keystone,
    query: `
mutation {
  createUser(data: {
    friends: { create: [{ name: "${sampleOne(alphanumGenerator)}" }] }
  }) { id friends { id } }
}`,
  });
  const { User, Friend } = await getUserAndFriend(
    keystone,
    createUser.id,
    createUser.friends[0].id
  );

  // Sanity check the links are setup correctly
  expect(User.friends.map(({ id }) => id.toString())).toEqual([Friend.id]);
  expect(Friend.friendOf.id.toString()).toBe(User.id.toString());

  return { user: createUser, friend: createUser.friends[0] };
};

const getUserAndFriend = async (keystone, userId, friendId) => {
  const { data } = await graphqlRequest({
    keystone,
    query: `
  {
    User(where: { id: "${userId}"} ) { id friends { id } }
    Friend: User(where: { id: "${friendId}"} ) { id friendOf { id } }
  }`,
  });
  return data;
};

const createReadData = async keystone => {
  // create locations [A, A, B, B, C, C];
  const { data } = await graphqlRequest({
    keystone,
    query: `mutation create($users: [UsersCreateInput]) { createUsers(data: $users) { id name } }`,
    variables: {
      users: ['A', 'A', 'B', 'B', 'C', 'C'].map(name => ({ data: { name } })),
    },
  });
  const { createUsers } = data;
  await Promise.all(
    Object.entries({
      ABC: [0, 2, 4], //  -> [A, B, C]
      AB: [1, 3], //  -> [A, B]
      C: [5], //  -> [C]
      '': [], //  -> []
    }).map(async ([name, locationIdxs], j) => {
      const ids = locationIdxs.map(i => ({ id: createUsers[i].id }));
      const { data } = await graphqlRequest({
        keystone,
        query: `mutation create($friends: [UserWhereUniqueInput], $name: String) { createUser(data: {
          name: $name
          friends: { connect: $friends }
  }) { id friends { name }}}`,
        variables: { friends: ids, name },
      });
      return data.updateUser;
    })
  );
};

multiAdapterRunners().map(({ runner, adapterName }) =>
  describe(`Adapter: ${adapterName}`, () => {
    // 1:1 relationships are symmetric in how they behave, but
    // are (in general) implemented in a non-symmetric way. For example,
    // in postgres we may decide to store a single foreign key on just
    // one of the tables involved. As such, we want to ensure that our
    // tests work correctly no matter which side of the relationship is
    // defined first.
    const createListsLR = keystone => {
      keystone.createList('User', {
        fields: {
          name: { type: Text },
          friends: { type: Relationship, ref: 'User.friendOf', many: true },
          friendOf: { type: Relationship, ref: 'User.friends' },
        },
      });
    };
    const createListsRL = keystone => {
      keystone.createList('User', {
        fields: {
          name: { type: Text },
          friendOf: { type: Relationship, ref: 'User.friends' },
          friends: { type: Relationship, ref: 'User.friendOf', many: true },
        },
      });
    };

    [
      [createListsLR, 'Left -> Right'],
      [createListsRL, 'Right -> Left'],
    ].forEach(([createLists, order]) => {
      describe(`One-to-many relationships - ${order}`, () => {
        function setupKeystone(adapterName) {
          return setupServer({
            adapterName,
            name: `ks5-testdb-${cuid()}`,
            createLists,
          });
        }

        describe('Read', () => {
          test(
            'one',
            runner(setupKeystone, async ({ keystone }) => {
              await createReadData(keystone);
              await Promise.all(
                [
                  ['A', 5],
                  ['B', 5],
                  ['C', 4],
                  ['D', 0],
                ].map(async ([name, count]) => {
                  const { data } = await graphqlRequest({
                    keystone,
                    query: `{ allUsers(where: { friendOf: { name_contains: "${name}"}}) { id }}`,
                  });
                  expect(data.allUsers.length).toEqual(count);
                })
              );
            })
          );
          test(
            '_some',
            runner(setupKeystone, async ({ keystone }) => {
              await createReadData(keystone);
              await Promise.all(
                [
                  ['A', 2],
                  ['B', 2],
                  ['C', 2],
                  ['D', 0],
                ].map(async ([name, count]) => {
                  const { data } = await graphqlRequest({
                    keystone,
                    query: `{ allUsers(where: { friends_some: { name: "${name}"}}) { id }}`,
                  });
                  expect(data.allUsers.length).toEqual(count);
                })
              );
            })
          );
          test(
            '_none',
            runner(setupKeystone, async ({ keystone }) => {
              await createReadData(keystone);
              await Promise.all(
                [
                  ['A', 2 + 6],
                  ['B', 2 + 6],
                  ['C', 2 + 6],
                  ['D', 4 + 6],
                ].map(async ([name, count]) => {
                  const { data } = await graphqlRequest({
                    keystone,
                    query: `{ allUsers(where: { friends_none: { name: "${name}"}}) { id }}`,
                  });
                  expect(data.allUsers.length).toEqual(count);
                })
              );
            })
          );
          test(
            '_every',
            runner(setupKeystone, async ({ keystone }) => {
              await createReadData(keystone);
              await Promise.all(
                [
                  ['A', 1 + 6],
                  ['B', 1 + 6],
                  ['C', 2 + 6],
                  ['D', 1 + 6],
                ].map(async ([name, count]) => {
                  const { data } = await graphqlRequest({
                    keystone,
                    query: `{ allUsers(where: { friends_every: { name: "${name}"}}) { id }}`,
                  });
                  expect(data.allUsers.length).toEqual(count);
                })
              );
            })
          );
        });

        describe('Create', () => {
          test(
            'With connect',
            runner(setupKeystone, async ({ keystone }) => {
              const { locations } = await createInitialData(keystone);
              const location = locations[0];
              const { data, errors } = await graphqlRequest({
                keystone,
                query: `
                mutation {
                  createUser(data: {
                    locations: { connect: [{ id: "${location.id}" }] }
                  }) { id locations { id } }
                }
            `,
              });
              expect(errors).toBe(undefined);
              expect(data.createUser.locations.map(({ id }) => id.toString())).toEqual([
                location.id,
              ]);

              const { Company, Location } = await getUserAndFriend(
                keystone,
                data.createUser.id,
                location.id
              );

              // Everything should now be connected
              expect(data.createUser.locations.map(({ id }) => id.toString())).toEqual([
                location.id,
              ]);
              expect(Location.company.id.toString()).toBe(Company.id.toString());
            })
          );

          test(
            'With create',
            runner(setupKeystone, async ({ keystone }) => {
              const locationName = sampleOne(alphanumGenerator);
              const { data, errors } = await graphqlRequest({
                keystone,
                query: `
                mutation {
                  createUser(data: {
                    locations: { create: [{ name: "${locationName}" }] }
                  }) { id locations { id } }
                }
            `,
              });
              expect(errors).toBe(undefined);

              const { Company, Location } = await getUserAndFriend(
                keystone,
                data.createUser.id,
                data.createUser.locations[0].id
              );

              // Everything should now be connected
              expect(Company.locations.map(({ id }) => id.toString())).toEqual([
                Location.id.toString(),
              ]);
              expect(Location.company.id.toString()).toBe(Company.id.toString());
            })
          );

          test.failing(
            'With nested connect',
            runner(setupKeystone, async ({ keystone }) => {
              const { companies } = await createInitialData(keystone);
              const company = companies[0];
              const locationName = sampleOne(alphanumGenerator);

              const { data, errors } = await graphqlRequest({
                keystone,
                query: `
                mutation {
                  createUser(data: {
                    locations: { create: [{ name: "${locationName}" company: { connect: { id: "${company.id}" } } }] }
                  }) { id locations { id company { id } } }
                }
            `,
              });
              expect(errors).toBe(undefined);

              const { Company, Location } = await getUserAndFriend(
                keystone,
                data.createUser.id,
                data.createUser.locations[0].id
              );

              // Everything should now be connected
              expect(Company.locations.map(({ id }) => id.toString())).toEqual([Location.id]);
              expect(Location.company.id.toString()).toBe(Company.id.toString());

              const {
                data: { allCompanies },
              } = await graphqlRequest({
                keystone,
                query: `{ allCompanies { id locations { id company { id } } } }`,
              });

              // The nested company should not have a location
              expect(
                allCompanies.filter(({ id }) => id === Company.id)[0].locations[0].company.id
              ).toEqual(Company.id);
              allCompanies
                .filter(({ id }) => id !== Company.id)
                .forEach(company => {
                  expect(company.locations).toEqual([]);
                });
            })
          );

          test.failing(
            'With nested create',
            runner(setupKeystone, async ({ keystone }) => {
              const locationName = sampleOne(alphanumGenerator);
              const companyName = sampleOne(alphanumGenerator);

              const { data, errors } = await graphqlRequest({
                keystone,
                query: `
                mutation {
                  createUser(data: {
                    locations: { create: [{ name: "${locationName}" company: { create: { name: "${companyName}" } } }] }
                  }) { id locations { id company { id } } }
                }
            `,
              });
              expect(errors).toBe(undefined);

              const { Company, Location } = await getUserAndFriend(
                keystone,
                data.createUser.id,
                data.createUser.locations[0].id
              );
              // Everything should now be connected
              expect(Company.locations.map(({ id }) => id.toString())).toEqual([Location.id]);
              expect(Location.company.id.toString()).toBe(Company.id.toString());

              // The nested company should not have a location
              const {
                data: { allCompanies },
              } = await graphqlRequest({
                keystone,
                query: `{ allCompanies { id locations { id company { id } } } }`,
              });
              expect(
                allCompanies.filter(({ id }) => id === Company.id)[0].locations[0].company.id
              ).toEqual(Company.id);
              allCompanies
                .filter(({ id }) => id !== Company.id)
                .forEach(company => {
                  expect(company.locations).toEqual([]);
                });
            })
          );
        });

        describe('Update', () => {
          test(
            'With connect',
            runner(setupKeystone, async ({ keystone }) => {
              // Manually setup a connected Company <-> Location
              const { user, friend } = await createUserAndFriend(keystone);

              // Sanity check the links don't yet exist
              // `...not.toBe(expect.anything())` allows null and undefined values
              expect(user.friends).not.toBe(expect.anything());
              expect(friend.friendOf).not.toBe(expect.anything());

              const { errors } = await graphqlRequest({
                keystone,
                query: `
                mutation {
                  updateUser(
                    id: "${user.id}",
                    data: { friends: { connect: [{ id: "${friend.id}" }] } }
                  ) { id friends { id } } }
            `,
              });
              expect(errors).toBe(undefined);

              const { User, Friend } = await getUserAndFriend(keystone, user.id, friend.id);
              // Everything should now be connected
              expect(User.friends.map(({ id }) => id.toString())).toEqual([Friend.id.toString()]);
              expect(Friend.friendOf.id.toString()).toBe(User.id.toString());
            })
          );

          test(
            'With create',
            runner(setupKeystone, async ({ keystone }) => {
              const { users } = await createInitialData(keystone);
              let user = users[0];
              const friendName = sampleOne(alphanumGenerator);
              const { data, errors } = await graphqlRequest({
                keystone,
                query: `
                mutation {
                  updateUser(
                    id: "${user.id}",
                    data: { friends: { create: [{ name: "${friendName}" }] } }
                  ) { id friends { id name } }
                }
            `,
              });
              expect(errors).toBe(undefined);

              const { User, Friend } = await getUserAndFriend(
                keystone,
                user.id,
                data.updateUser.friends[0].id
              );

              // Everything should now be connected
              expect(User.friends.map(({ id }) => id.toString())).toEqual([Friend.id.toString()]);
              expect(Friend.friendOf.id.toString()).toBe(User.id.toString());
            })
          );

          test(
            'With disconnect',
            runner(setupKeystone, async ({ keystone }) => {
              // Manually setup a connected Company <-> Location
              const { user, friend } = await createUserAndFriend(keystone);

              // Run the query to disconnect the location from company
              const { data, errors } = await graphqlRequest({
                keystone,
                query: `
                mutation {
                  updateUser(
                    id: "${user.id}",
                    data: { friends: { disconnect: [{ id: "${friend.id}" }] } }
                  ) { id friends { id name } }
                }
            `,
              });
              expect(errors).toBe(undefined);
              expect(data.updateUser.id).toEqual(user.id);
              expect(data.updateUser.friends).toEqual([]);

              // Check the link has been broken
              const result = await getUserAndFriend(keystone, user.id, friend.id);
              expect(result.User.friends).toEqual([]);
              expect(result.Friend.friendOf).toBe(null);
            })
          );

          test(
            'With disconnectAll',
            runner(setupKeystone, async ({ keystone }) => {
              // Manually setup a connected Company <-> Location
              const { user, friend } = await createUserAndFriend(keystone);

              // Run the query to disconnect the location from company
              const { data, errors } = await graphqlRequest({
                keystone,
                query: `
                mutation {
                  updateUser(
                    id: "${user.id}",
                    data: { friends: { disconnectAll: true } }
                  ) { id friends { id name } }
                }
            `,
              });
              expect(errors).toBe(undefined);
              expect(data.updateUser.id).toEqual(user.id);
              expect(data.updateUser.friends).toEqual([]);

              // Check the link has been broken
              const result = await getUserAndFriend(keystone, user.id, friend.id);
              expect(result.User.friends).toEqual([]);
              expect(result.Friend.friendOf).toBe(null);
            })
          );
        });

        describe('Delete', () => {
          test(
            'delete',
            runner(setupKeystone, async ({ keystone }) => {
              // Manually setup a connected Company <-> Location
              const { user, friend } = await createUserAndFriend(keystone);

              // Run the query to disconnect the location from company
              const { data, errors } = await graphqlRequest({
                keystone,
                query: `mutation { deleteUser(id: "${user.id}") { id } } `,
              });
              expect(errors).toBe(undefined);
              expect(data.deleteUser.id).toBe(user.id);

              // Check the link has been broken
              const result = await getUserAndFriend(keystone, user.id, friend.id);
              expect(result.User).toBe(null);
              expect(result.Friend.friendOf).toBe(null);
            })
          );
        });
      });
    });
  })
);
