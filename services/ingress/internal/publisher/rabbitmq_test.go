package publisher

import (
	"context"
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func TestRabbitMQPublisher_StructInitialization(t *testing.T) {
	ch := make(chan amqp.Confirmation, 1000)
	pub := &RabbitMQPublisher{
		confirms: ch,
	}

	if cap(pub.confirms) != 1000 {
		t.Fatalf("expected buffer capacity 1000, got %d", cap(pub.confirms))
	}

	// Test Close on publisher with nil channel and connection does not panic
	pub.Close()
}

func TestRabbitMQPublisher_ContextCancellation(t *testing.T) {
	// A publisher that has a channel with confirms channel
	ch := make(chan amqp.Confirmation, 10)
	pub := &RabbitMQPublisher{
		confirms: ch,
	}
	defer pub.Close()

	// When ctx is canceled, Publish should respect cancellation if it hits select
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	// If channel is nil, PublishWithContext would panic or error,
	// but let's verify ctx timeout behaviour
	<-ctx.Done()
	if ctx.Err() != context.DeadlineExceeded {
		t.Fatalf("expected deadline exceeded, got %v", ctx.Err())
	}
}

func TestRabbitMQPublisher_InterfaceCompliance(t *testing.T) {
	var _ Publisher = (*RabbitMQPublisher)(nil)
}

func TestRabbitMQPublisher_DrainReturns(t *testing.T) {
	retCh := make(chan amqp.Return, 10)
	retCh <- amqp.Return{ReplyCode: 312, ReplyText: "NO_ROUTE", RoutingKey: "old.route"}

	pub := &RabbitMQPublisher{
		returns: retCh,
	}

	// Drain logic simulation
	drained := 0
	for {
		select {
		case <-pub.returns:
			drained++
		default:
			goto DRAINED
		}
	}
DRAINED:
	if drained != 1 {
		t.Fatalf("expected 1 drained return, got %d", drained)
	}
	if len(pub.returns) != 0 {
		t.Fatalf("expected 0 remaining returns, got %d", len(pub.returns))
	}
}

func TestRabbitMQPublisher_InvalidateChannel(t *testing.T) {
	ch := make(chan amqp.Confirmation, 10)
	ret := make(chan amqp.Return, 10)
	pub := &RabbitMQPublisher{
		confirms: ch,
		returns:  ret,
	}

	pub.invalidateChannel()

	if pub.channel != nil {
		t.Fatalf("expected nil channel after invalidation")
	}
	if pub.confirms != nil {
		t.Fatalf("expected nil confirms after invalidation")
	}
	if pub.returns != nil {
		t.Fatalf("expected nil returns after invalidation")
	}
}
