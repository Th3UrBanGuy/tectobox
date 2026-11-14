package publisher

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/tect0nicofficial/tectobox/services/ingress/internal/topology"
)

// Publisher defines message publishing behavior for ingress handlers
type Publisher interface {
	Publish(ctx context.Context, routingKey string, body []byte) error
	Close()
}

type RabbitMQPublisher struct {
	url       string
	conn      *amqp.Connection
	channel   *amqp.Channel
	confirms  chan amqp.Confirmation
	returns   chan amqp.Return
	mu        sync.Mutex
	isClosed  bool
	closeChan chan struct{}
}

func NewRabbitMQPublisher(url string) (*RabbitMQPublisher, error) {
	startupTimeout := 60 * time.Second
	if val := os.Getenv("RABBITMQ_STARTUP_TIMEOUT_MS"); val != "" {
		if ms, err := strconv.Atoi(val); err == nil && ms >= 0 {
			startupTimeout = time.Duration(ms) * time.Millisecond
		}
	}

	var conn *amqp.Connection
	var err error
	start := time.Now()
	attempt := 0

	for {
		attempt++
		conn, err = amqp.Dial(url)
		if err == nil {
			break
		}
		elapsed := time.Since(start)
		if startupTimeout == 0 || elapsed >= startupTimeout {
			return nil, fmt.Errorf("failed to connect to RabbitMQ after %v (%d attempts): %w", elapsed, attempt, err)
		}
		backoff := 500 * time.Millisecond
		if backoff > startupTimeout-elapsed {
			backoff = startupTimeout - elapsed
		}
		log.Printf("[publisher] Startup connection attempt %d failed (%v), retrying in %v...", attempt, err, backoff)
		time.Sleep(backoff)
	}

	p := &RabbitMQPublisher{
		url:       url,
		conn:      conn,
		closeChan: make(chan struct{}),
	}

	if err := p.initChannel(); err != nil {
		_ = conn.Close()
		return nil, err
	}

	go p.watchConnection()

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
		topology.EVENTS_EXCHANGE, // name
		"topic",                  // type
		true,                     // durable
		false,                    // auto-deleted
		false,                    // internal
		false,                    // no-wait
		nil,                      // arguments
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

func (p *RabbitMQPublisher) watchConnection() {
	for {
		p.mu.Lock()
		if p.isClosed || p.conn == nil {
			p.mu.Unlock()
			return
		}
		connClose := p.conn.NotifyClose(make(chan *amqp.Error, 1))
		var chClose chan *amqp.Error
		if p.channel != nil {
			chClose = p.channel.NotifyClose(make(chan *amqp.Error, 1))
		}
		p.mu.Unlock()

		select {
		case err, ok := <-connClose:
			if !ok {
				return
			}
			log.Printf("[publisher] RabbitMQ connection closed: %v. Initiating reconnect with backoff...", err)
			p.reconnectWithBackoff()
		case err, ok := <-chClose:
			if !ok {
				return
			}
			log.Printf("[publisher] RabbitMQ channel closed: %v. Re-initializing channel...", err)
			p.mu.Lock()
			if !p.isClosed && p.conn != nil && !p.conn.IsClosed() {
				p.invalidateChannel()
				if initErr := p.initChannel(); initErr != nil {
					log.Printf("[publisher] Channel re-init failed: %v", initErr)
				}
			}
			p.mu.Unlock()
		case <-p.closeChan:
			return
		}
	}
}

func (p *RabbitMQPublisher) reconnectWithBackoff() {
	p.mu.Lock()
	if p.isClosed {
		p.mu.Unlock()
		return
	}
	p.invalidateChannel()
	if p.conn != nil {
		_ = p.conn.Close()
		p.conn = nil
	}
	p.mu.Unlock()

	delay := 1 * time.Second
	maxDelay := 30 * time.Second
	if val := os.Getenv("RABBITMQ_RECONNECT_MAX_MS"); val != "" {
		if ms, err := strconv.Atoi(val); err == nil && ms > 0 {
			maxDelay = time.Duration(ms) * time.Millisecond
		}
	}
	if val := os.Getenv("RABBITMQ_RECONNECT_INITIAL_MS"); val != "" {
		if ms, err := strconv.Atoi(val); err == nil && ms > 0 {
			delay = time.Duration(ms) * time.Millisecond
		}
	}

	for {
		p.mu.Lock()
		if p.isClosed {
			p.mu.Unlock()
			return
		}
		p.mu.Unlock()

		time.Sleep(delay)

		p.mu.Lock()
		if p.isClosed {
			p.mu.Unlock()
			return
		}
		log.Printf("[publisher] Attempting RabbitMQ reconnect...")
		conn, err := amqp.Dial(p.url)
		if err == nil {
			p.conn = conn
			if err := p.initChannel(); err == nil {
				log.Printf("[publisher] Successfully reconnected to RabbitMQ and redeclared topology")
				p.mu.Unlock()
				return
			}
			_ = conn.Close()
			p.conn = nil
		}
		log.Printf("[publisher] Reconnect failed (%v), retrying in %v...", err, delay)
		p.mu.Unlock()

		delay *= 2
		if delay > maxDelay {
			delay = maxDelay
		}
	}
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

	if p.isClosed {
		return fmt.Errorf("publisher is closed")
	}

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
		topology.EVENTS_EXCHANGE, // exchange
		routingKey,               // routing key
		true,                     // mandatory: return if unroutable
		false,                    // immediate
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
	if p.isClosed {
		p.mu.Unlock()
		return
	}
	p.isClosed = true
	if p.closeChan != nil {
		close(p.closeChan)
	}

	if p.channel != nil {
		_ = p.channel.Close()
		p.channel = nil
	}
	if p.conn != nil {
		_ = p.conn.Close()
		p.conn = nil
	}
	p.mu.Unlock()
}
