var makeProtocol = require("./");
var sodium = require("sodium-universal");
var tape = require("tape");

var FruitProtocol = makeProtocol({
  version: 1,
  messages: {
    apple: {
      schema: {
        type: "string",
        const: "apple"
      }
    },
    orange: {
      schema: {
        type: "string",
        const: "orange"
      }
    }
  }
});

tape("apple and orange", function(test) {
  test.plan(8);

  var replicationKey = randomReplicationKey();
  var seed = randomSeed();

  var anna = FruitProtocol({ replicationKey, seed });
  anna.handshake(function(error) {
    test.ifError(error, "anna sent handshake");
  });
  anna.once("handshake", function() {
    test.pass("anna received handshake");
    anna.once("apple", function(body) {
      test.equal(body, "apple", "anna received apple");
    });
    anna.orange("orange", function(error) {
      test.ifError(error, "anna sent orange");
    });
  });

  var bob = FruitProtocol({ replicationKey, seed });
  bob.handshake(function(error) {
    test.ifError(error, "bob sent handshake");
  });
  bob.once("handshake", function() {
    test.pass("bob received handshake");
    bob.once("orange", function(body) {
      test.equal(body, "orange", "bob received orange");
    });
    bob.apple("apple", function(error) {
      test.ifError(error, "bob sent apple");
    });
  });

  anna.pipe(bob).pipe(anna);
});

tape("multiple messages", function(test) {
  test.plan(6);

  var replicationKey = randomReplicationKey();
  var seed = randomSeed();

  var anna = FruitProtocol({ replicationKey, seed });
  anna.handshake(function(error) {
    test.ifError(error, "anna sent handshake");
    anna.on("apple", function() {
      test.pass("anna received apple");
    });
    anna.on("orange", function() {
      test.pass("anna received orange");
    });
  });

  var bob = FruitProtocol({ replicationKey, seed });
  bob.handshake(function(error) {
    test.ifError(error, "bob sent handshake");
    bob.apple("apple", function(error) {
      test.ifError(error, "bob sent handshake");
    });
    bob.orange("orange", function(error) {
      test.ifError(error, "bob sent handshake");
    });
  });

  anna.pipe(bob).pipe(anna);
});

tape("version conflict", function(test) {
  test.plan(6);

  var Version1 = makeProtocol({
    version: 1,
    messages: { hello: { schema: { type: "string", const: "hello" } } }
  });

  var Version2 = makeProtocol({
    version: 2,
    messages: { howdy: { schema: { type: "string", const: "howdy" } } }
  });

  var replicationKey = randomReplicationKey();
  var seed = randomSeed();

  var anna = Version1({ replicationKey, seed }).once("error", function(error) {
    test.equal(error.message, "version mismatch");
    test.equal(error.version, 2);
  });
  anna.handshake(function(error) {
    test.ifError(error, "anna sent handshake");
  });

  var bob = Version2({ replicationKey, seed }).once("error", function(error) {
    test.equal(error.message, "version mismatch");
    test.equal(error.version, 1);
  });
  bob.handshake(function(error) {
    test.ifError(error, "anna sent handshake");
  });

  anna.pipe(bob).pipe(anna);
});

tape("double handshake", function(test) {
  var replicationKey = randomReplicationKey();
  var seed = randomSeed();
  var anna = FruitProtocol({ replicationKey, seed });
  anna.handshake(function(error) {
    test.ifError(error);
    anna.handshake(function(error) {
      test.equal(error.message, "already sent handshake");
      test.end();
    });
  });
});

tape("invalid message", function(test) {
  var replicationKey = randomReplicationKey();
  var seed = randomSeed();
  var anna = FruitProtocol({ replicationKey, seed });
  test.throws(
    function() {
      anna.apple("orange", function() {
        /* pass */
      });
    },
    "invalid apple",
    "invalid apple"
  );
  test.end();
});

tape("verify", function(test) {
  var ProtocolWithValid = makeProtocol({
    version: 1,
    messages: {
      hello: {
        schema: { type: "string" },
        verify: function(body) {
          return body === "hello";
        }
      }
    }
  });
  var anna = ProtocolWithValid({
    replicationKey: randomReplicationKey(),
    seed: randomSeed()
  });
  test.throws(function() {
    anna.hello("howdy", function() {
      /* pass */
    });
  }, "invalid hello");
  test.end();
});

function randomReplicationKey() {
  var key = Buffer.alloc(32);
  sodium.randombytes_buf(key);
  return key;
}

function randomSeed() {
  var seed = Buffer.alloc(sodium.crypto_sign_SEEDBYTES);
  sodium.randombytes_buf(seed);
  return seed;
}
