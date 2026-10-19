package publisher

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// Publisher defines message publishing behavior for ingress handlers
type Publisher interface {
	Publish(ctx context.Context, routingKey string, body []byte) error
	Close()
}

type RabbitMQPublisher struct {
	url      string
	conn     *amqp.Connection
	channel  *amqp.Channel
	confirms chan amqp.Confirmation
	returns  chan amqp.Return
	mu       sync.Mutex
}

func NewRabbitMQPublisher(url string) (*RabbitMQPublisher, error) {
	conn, err := amqp.Dial(url)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to RabbitMQ: %w", err)
	}

	p := &RabbitMQPublisher{
		url:  url,
		conn: conn,
	}

	if err := p.initChannel(); err != nil {
		conn.Close()
		return nil, err
	}

	return p, nil
}

func (p *RabbitMQPublisher) initChannel() error {
	ch, err := p.conn.Channel()
	if err != nil {
		return fmt.Errorf("failed to open a channel: %w", err)
	}

	// Enable publisher confirms
	if err := ch.Confirm(false); err != nil {
		ch.Close()
		return fmt.Errorf("failed to enable publisher confirms: %w", err)
	}

	// Declare exchange
	err = ch.ExchangeDeclare(
		"tectobox.events", // name
		"topic",           // type
		true,              // durable
		false,             // auto-deleted
		false,             // internal
		false,             // no-wait
		nil,               // arguments
	)
	if err != nil {
		ch.Close()
		return fmt.Errorf("failed to declare an exchange: %w", err)
	}

	// Register notifications
	confirms := ch.NotifyPublish(make(chan amqp.Confirmation, 100))
	returns := ch.NotifyReturn(make(chan amqp.Return, 100))

	p.channel = ch
	p.confirms = confirms
	p.returns = returns
	return nil
}

// invalidateChannel closes and discards current channel on desync or error
func (p *RabbitMQPublisher) invalidateChannel() {
	if p.channel != nil {
		_ = p.channel.Close()
		p.channel = nil
	}
	p.confirms = nil
	p.returns = nil
}

func (p *RabbitMQPublisher) Publish(ctx context.Context, routingKey string, body []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	// If channel was invalidated due to previous desync/timeout, reopen it
	if p.channel == nil {
		if p.conn == nil || p.conn.IsClosed() {
			conn, err := amqp.Dial(p.url)
			if err != nil {
				return fmt.Errorf("connection closed and reconnect failed: %w", err)
			}
			p.conn = conn
		}
		if err := p.initChannel(); err != nil {
			return fmt.Errorf("failed to reinitialize channel: %w", err)
		}
	}

	// In single-flight confirm mode under mutex lock, ensure notify channels are clean
	for {
		select {
		case r := <-p.returns:
			log.Printf("[publisher] drained previous unrouted return: code=%d key=%s", r.ReplyCode, r.RoutingKey)
		case c := <-p.confirms:
			log.Printf("[publisher] drained previous stray confirm: tag=%d ack=%v", c.DeliveryTag, c.Ack)
		default:
			goto DRAIN_DONE
		}
	}
DRAIN_DONE:

	err := p.channel.PublishWithContext(ctx,
		"tectobox.events", // exchange
		routingKey,        // routing key
		true,              // mandatory: return if unroutable
		false,             // immediate
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			Body:         body,
		})
	if err != nil {
		p.invalidateChannel()
		return fmt.Errorf("failed to publish a message: %w", err)
	}

	// Wait for correlated return or confirm.
	// When mandatory=true, RabbitMQ sends basic.return BEFORE basic.ack if unroutable.
	select {
	case ret := <-p.returns:
		// Drain the corresponding confirm that RabbitMQ sends right after the return
		select {
		case <-p.confirms:
		case <-time.After(500 * time.Millisecond):
			p.invalidateChannel()
		}
		return fmt.Errorf("unroutable message returned by broker (code=%d, text=%s, key=%s)", ret.ReplyCode, ret.ReplyText, ret.RoutingKey)

	case confirmed := <-p.confirms:
		if !confirmed.Ack {
			p.invalidateChannel()
			return fmt.Errorf("negative publisher confirmation received (deliveryTag=%d)", confirmed.DeliveryTag)
		}
		// Confirm arrived. Ensure no concurrent return was queued.
		select {
		case ret := <-p.returns:
			return fmt.Errorf("unroutable message returned by broker (code=%d, text=%s, key=%s)", ret.ReplyCode, ret.ReplyText, ret.RoutingKey)
		default:
		}

	case <-ctx.Done():
		// On context cancellation or timeout, deliveryTag / notification alignment is lost.
		// Invalidate channel to prevent corrupting subsequent publishes.
		p.invalidateChannel()
		return ctx.Err()
	}

	log.Printf("Published message to %s (confirmed and routed)", routingKey)
	return nil
}

func (p *RabbitMQPublisher) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.channel != nil {
		p.channel.Close()
		p.channel = nil
	}
	if p.conn != nil {
		p.conn.Close()
		p.conn = nil
	}
}
